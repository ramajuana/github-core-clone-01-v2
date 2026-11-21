// The git object model, implemented from the protocol documents: SHA-1 object ids, loose-object
// hashing, tree/commit/tag parsing and building, packfile reading (with OFS/REF delta resolution)
// and packfile writing (plain objects, no deltas), plus the pkt-line codec smart HTTP speaks.
// Node built-ins only; no git binary is ever invoked.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
export const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/** SHA-1 over `<type> <size>\0` + bytes: git's object id. */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, directories compared as if the name ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
}): Buffer {
  const who = `${fields.authorName} <${fields.authorEmail}> ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------------------------
// reachability and tree flattening over an object store
// ---------------------------------------------------------------------------------------------

export type Store = Map<string, GitObj>;

/** Every object reachable from the roots (commit -> tree + parents, tree -> entries, tag -> target). */
export function collectReachable(store: Store, roots: Iterable<string>, options: { allowMissing?: boolean } = {}): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Just the tree closure of one commit (the commit itself is not included). */
export function treeClosure(store: Store, commitOid: string): Set<string> {
  const out = new Set<string>();
  const commit = store.get(commitOid);
  if (!commit || commit.type !== 'commit') return out;
  const queue = [parseCommit(commit.data).tree];
  while (queue.length) {
    const oid = queue.pop()!;
    if (out.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    out.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return out;
}

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** A tree flattened to `path -> {mode, oid}` for blobs (and gitlinks, kept but never followed). */
export function flattenTree(store: Store, treeOid: string, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  const tree = store.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Store a blob and answer its id. */
export function storeBlob(store: Store, data: Buffer): string {
  const oid = hashObject('blob', data);
  if (!store.has(oid)) store.set(oid, { type: 'blob', data });
  return oid;
}

/** Build (and store) the nested trees for a flattened path map; answers the root tree id. */
export function treeFromFlat(store: Store, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Dir {
    files: TreeEntry[];
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: [], dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      let next = dir.dirs.get(segment);
      if (!next) {
        next = { files: [], dirs: new Map() };
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.push({ mode: entry.mode, name: segments[segments.length - 1], oid: entry.oid });
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [...dir.files];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!store.has(oid)) store.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** Resolve a tag (or tag chain) to the commit it points at; a commit resolves to itself. */
export function peelToCommit(store: Store, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = store.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** The commit a ref value names, following tags; null when the value names no commit. */
export function refCommit(store: Store, oid: string): string | null {
  return peelToCommit(store, oid);
}

// ---------------------------------------------------------------------------------------------
// delta application (the instruction stream a pack delta carries)
// ---------------------------------------------------------------------------------------------

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine.bytesWritten) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/**
 * Read a packfile and resolve every object. `resolveBase` supplies objects a thin pack leaves out
 * (REF_DELTA bases the receiver already holds). Throws on any structural problem.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (computed !== pack.subarray(trailerStart).toString('hex')) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: GitObj;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  const resolvedByOid = new Map<string, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} inflated to the wrong size`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { oid: string; object: GitObj } => {
    if (entry.resolved && entry.oid) return { oid: entry.oid, object: entry.resolved };
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let object: GitObj;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      object = { type: base.object.type, data: applyDelta(base.object.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        object = { type: base.object.type, data: applyDelta(base.object.data, entry.data) };
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (!external) throw new Error(`ref-delta base ${entry.baseOid} is not available`);
        object = { type: external.type, data: applyDelta(external.data, entry.data) };
      }
    } else {
      object = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    }
    const oid = hashObject(object.type, object.data);
    entry.resolved = object;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { oid, object };
  };

  const objects = new Map<string, GitObj>();
  for (const entry of raw) {
    const { oid, object } = resolve(entry);
    if (!objects.has(oid)) objects.set(oid, object);
  }
  return objects;
}

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas); the trailer is the SHA-1 of everything before it. */
export function writePack(objects: Iterable<GitObj>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export const PKT_MAX = 65520;

export function encodePkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_MAX) throw new Error('pkt-line payload is too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode a complete pkt-line stream. Returns the packets and the number of bytes consumed; stops
 * (without consuming) at the first bytes that are not a pkt-line header, which is how a receive-pack
 * body hands over to its raw packfile. Throws on a malformed or truncated packet.
 */
export function decodePkts(buffer: Buffer, start = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const headerText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(headerText)) return { packets, next: offset };
    const length = Number.parseInt(headerText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3 || length > PKT_MAX) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return { packets, next: offset };
}

/** The text lines of the data packets in a decoded stream. */
export function pktLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}
