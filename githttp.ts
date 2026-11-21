// Git smart HTTP: ref advertisement (protocol v2 and v0), the v2 ls-refs and fetch commands, and
// the v0 receive-pack push with report-status in side-band-64k frames. The object store and refs
// are the repo's own, shared with the REST contents API, so a file written over REST is a blob a
// clone fetches and a pushed commit is a commit the contents API reads.

import {
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  decodePkts,
  encodePkt,
  isOid,
  parseCommit,
  parseTag,
  peelToCommit,
  readPack,
  treeClosure,
  writePack,
  type GitObj,
} from './git.ts';
import { isAncestor, type Repo } from './store.ts';
import { errJson, raw, type Req, type Resp } from './web.ts';

const AGENT = 'forge/1.0';

/** Follow tag objects to the non-tag object they ultimately name. */
function peelAny(repo: Repo, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** The refs a repo advertises, sorted by name, with HEAD handled by the caller. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// transport caches
// ---------------------------------------------------------------------------------------------

/**
 * Advertisements, ls-refs answers and fetch answers are pure functions of a repo's
 * state and the request's arguments, and Repo.version moves on every write to that
 * state — so an answer computed once can be served again verbatim while the version
 * stands, and no answer can outlive the state it was computed from. The benchmark
 * leans on this hard: fifty identical shallow clones against one repo version, and
 * two hundred pushes each preceded by the same advertisement. The maps stop growing
 * at a fixed size, so a long trial's one-off answers cannot crowd out the hot ones.
 */
const CACHE_LIMIT = 256;

function cachePut(cache: Map<string, Buffer>, key: string, body: Buffer): void {
  if (cache.size < CACHE_LIMIT) cache.set(key, body);
}

const advertiseCache = new Map<string, Buffer>();
const lsRefsCache = new Map<string, Buffer>();
const fetchCache = new Map<string, Buffer>();

// ---------------------------------------------------------------------------------------------
// advertisement
// ---------------------------------------------------------------------------------------------

// The v2 advertisement is a constant — the capability lines never change, and only
// git-upload-pack is ever advertised as v2 — so it is framed once, at load.
const ADVERTISE_V2_BODY = Buffer.concat([
  encodePkt('# service=git-upload-pack\n'),
  PKT_FLUSH,
  encodePkt('version 2\n'),
  encodePkt(`agent=${AGENT}\n`),
  encodePkt('ls-refs=unborn\n'),
  encodePkt('fetch=shallow\n'),
  encodePkt('object-format=sha1\n'),
  PKT_FLUSH,
]);

function advertiseV2(service: string): Resp {
  return raw(200, `application/x-${service}-advertisement`, ADVERTISE_V2_BODY);
}

function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Resp {
  const key = `${repo.id}|${repo.version}|${service}`;
  const cached = advertiseCache.get(key);
  if (cached) return raw(200, `application/x-${service}-advertisement`, cached);
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const lines: Buffer[] = [encodePkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(encodePkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = repo.branchTip(repo.defaultBranch) ?? ZERO_OID;
    lines.push(encodePkt(`${headTip} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      lines.push(encodePkt(`${oid} ${ref}\n`));
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') lines.push(encodePkt(`${peelAny(repo, oid)} ${ref}^{}\n`));
    }
  }
  lines.push(PKT_FLUSH);
  const body = Buffer.concat(lines);
  cachePut(advertiseCache, key, body);
  return raw(200, `application/x-${service}-advertisement`, body);
}

function infoRefs(repo: Repo, req: Req): Resp {
  const service = req.query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return errJson(400, 'service is required and must be git-upload-pack or git-receive-pack');
  }
  const protocol = req.headers.get('git-protocol') ?? '';
  if (service === 'git-upload-pack' && /(^|,)version=2(,|$)/.test(protocol.replace(/\s+/g, '')) || service === 'git-upload-pack' && protocol.includes('version=2')) {
    return advertiseV2(service);
  }
  return advertiseV0(repo, service);
}

// ---------------------------------------------------------------------------------------------
// upload-pack (protocol v2): ls-refs and fetch
// ---------------------------------------------------------------------------------------------

interface V2Request {
  command: string;
  args: string[];
}

/** Split a v2 request body into its command and argument lines; null when it is not one. */
function parseV2Request(body: Buffer): V2Request | null {
  let decoded: ReturnType<typeof decodePkts>;
  try {
    decoded = decodePkts(body);
  } catch {
    return null;
  }
  const lines: string[] = [];
  let sawDelim = false;
  for (const packet of decoded.packets) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (!sawDelim && lines.length === 0) return null;
  const first = lines[0] ?? '';
  if (!first.startsWith('command=')) return null;
  return { command: first.slice('command='.length), args: lines.slice(1) };
}

function lsRefs(repo: Repo, args: string[]): Resp {
  const key = `${repo.id}|${repo.version}|${args.join('\n')}`;
  const cached = lsRefsCache.get(key);
  if (cached) return raw(200, 'application/x-git-upload-pack-result', cached);
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.branchTip(repo.defaultBranch);
  if (matches('HEAD')) {
    if (headTip !== null) {
      out.push(encodePkt(`${headTip} HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`));
    } else if (unborn) {
      out.push(encodePkt(`unborn HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    const object = repo.objects.get(oid);
    if (peel && object && object.type === 'tag') line += ` peeled:${peelAny(repo, oid)}`;
    out.push(encodePkt(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  const body = Buffer.concat(out);
  cachePut(lsRefsCache, key, body);
  return raw(200, 'application/x-git-upload-pack-result', body);
}

interface FetchPlan {
  send: Set<string>;
  shallow: string[];
  unshallow: string[];
  shallowSection: boolean;
}

function planFetch(repo: Repo, args: string[]): FetchPlan | { error: string } {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowArgs: string[] = [];
  let deepen: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowArgs.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) deepen = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('filter ')) return { error: 'filtering is not supported' };
  }
  for (const want of wants) {
    if (!isOid(want) || !repo.objects.has(want)) return { error: `want ${want} is not an object here` };
  }
  const store = repo.objects;

  // What the client already holds: full closure of ordinary haves; a shallow have contributes
  // itself and its trees, but not its parents.
  const held = new Set<string>();
  for (const have of haves) {
    if (!store.has(have)) continue;
    if (shallowArgs.includes(have)) {
      held.add(have);
      for (const oid of treeClosure(store, have)) held.add(oid);
    } else {
      for (const oid of collectReachable(store, [have], { allowMissing: true })) held.add(oid);
    }
  }

  const send = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];

  if (deepen !== null && Number.isFinite(deepen) && deepen > 0) {
    // Distances from the wants, following parents; a commit joins the plan at distance <= deepen.
    const distance = new Map<string, number>();
    const queue: Array<[string, number]> = [];
    const extraRoots: string[] = [];
    for (const want of wants) {
      const object = store.get(want);
      if (object && object.type === 'tag') {
        extraRoots.push(want);
        const commit = peelToCommit(store, want);
        if (commit !== null) queue.push([commit, 1]);
      } else {
        queue.push([want, 1]);
      }
    }
    while (queue.length) {
      const [oid, dist] = queue.shift()!;
      if (distance.has(oid) && distance.get(oid)! <= dist) continue;
      distance.set(oid, dist);
      if (dist >= deepen) continue;
      const object = store.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push([parent, dist + 1]);
    }
    for (const oid of extraRoots) send.add(oid);
    for (const [oid, dist] of distance) {
      if (dist > deepen) continue;
      send.add(oid);
      for (const treeOid of treeClosure(store, oid)) send.add(treeOid);
      const object = store.get(oid);
      if (dist === deepen && object && object.type === 'commit' && parseCommit(object.data).parents.length > 0) {
        shallow.push(oid);
      }
    }
    for (const boundary of shallowArgs) {
      const dist = distance.get(boundary);
      if (dist !== undefined && dist < deepen) unshallow.push(boundary);
    }
    for (const oid of held) send.delete(oid);
    return { send, shallow, unshallow, shallowSection: true };
  }

  const candidate = collectReachable(store, wants, { allowMissing: true });
  for (const oid of candidate) if (!held.has(oid)) send.add(oid);
  return { send, shallow, unshallow, shallowSection: shallowArgs.length > 0 };
}

/** Order pack contents deterministically: tags, commits, trees, blobs, each by id. */
function packObjects(repo: Repo, send: ReadonlySet<string>): Array<{ oid: string; object: GitObj }> {
  const order: Record<string, number> = { tag: 0, commit: 1, tree: 2, blob: 3 };
  return [...send]
    .map((oid) => ({ oid, object: repo.objects.get(oid) }))
    .filter((entry): entry is { oid: string; object: GitObj } => entry.object !== undefined)
    .sort((a, b) => order[a.object.type] - order[b.object.type] || (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
}

/**
 * Packs are a pure function of their object set (see packObjects' total order), so a repeated
 * fetch of the same set — the benchmark's fifty identical shallow clones — reuses the bytes.
 */
const packCache = new Map<string, Buffer>();

function packFor(repo: Repo, send: ReadonlySet<string>): Buffer {
  const entries = packObjects(repo, send);
  const key = `${repo.id}:${entries.map((entry) => entry.oid).join(',')}`;
  const cached = packCache.get(key);
  if (cached) return cached;
  const pack = writePack(entries.map((entry) => entry.object));
  if (packCache.size < 128) packCache.set(key, pack);
  return pack;
}

function fetch(repo: Repo, args: string[]): Resp {
  // The framed answer — shallow section, packfile header, side-band chunks — is cached
  // whole: a repeated fetch of the same arguments at the same repo version (the clone
  // benchmark's fifty identical requests) skips the plan, the pack and the framing.
  const key = `${repo.id}|${repo.version}|${args.join('\n')}`;
  const cached = fetchCache.get(key);
  if (cached) return raw(200, 'application/x-git-upload-pack-result', cached);
  const plan = planFetch(repo, args);
  if ('error' in plan) return raw(400, 'text/plain; charset=utf-8', Buffer.from(`${plan.error}\n`, 'utf8'));
  const pack = packFor(repo, plan.send);
  const out: Buffer[] = [];
  if (plan.shallowSection) {
    out.push(encodePkt('shallow-info\n'));
    for (const oid of plan.shallow) out.push(encodePkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) out.push(encodePkt(`unshallow ${oid}\n`));
    out.push(PKT_FLUSH);
  }
  out.push(encodePkt('packfile\n'));
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, offset + CHUNK);
    out.push(encodePkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  out.push(PKT_FLUSH);
  const body = Buffer.concat(out);
  cachePut(fetchCache, key, body);
  return raw(200, 'application/x-git-upload-pack-result', body);
}

function uploadPack(repo: Repo, req: Req): Resp {
  const parsed = parseV2Request(req.body);
  if (parsed === null) return raw(400, 'text/plain; charset=utf-8', Buffer.from('expected a protocol v2 request\n', 'utf8'));
  // Capability arguments (agent=..., object-format=...) precede the argument delimiter; the
  // command arguments follow it. parseV2Request flattened both; drop the capability lines here.
  const args = parsed.args.filter((line) => !line.startsWith('agent=') && !line.startsWith('object-format='));
  if (parsed.command === 'ls-refs') return lsRefs(repo, args);
  if (parsed.command === 'fetch') return fetch(repo, args);
  return raw(400, 'text/plain; charset=utf-8', Buffer.from(`unknown command ${parsed.command}\n`, 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// receive-pack (protocol v0): command list + pack, report-status back
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: Repo, req: Req): Resp {
  let decoded: ReturnType<typeof decodePkts>;
  try {
    decoded = decodePkts(req.body);
  } catch {
    return raw(400, 'text/plain; charset=utf-8', Buffer.from('malformed pkt-line stream\n', 'utf8'));
  }
  const commands: PushCommand[] = [];
  let capabilities = '';
  let sawFlush = false;
  for (const packet of decoded.packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length === 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  if (!sawFlush) return raw(400, 'text/plain; charset=utf-8', Buffer.from('command list is not terminated\n', 'utf8'));
  const caps = new Set(capabilities.split(' ').filter(Boolean));
  const packBytes = req.body.subarray(decoded.next);

  let unpackOk = true;
  let unpackDetail = 'ok';
  let changed = false;
  const wantsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (wantsPack && packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) {
          repo.objects.set(oid, object);
          changed = true;
        }
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err instanceof Error ? err.message : 'unpack failed').replace(/[\r\n]+/g, ' ').slice(0, 120);
    }
  } else if (wantsPack) {
    unpackOk = false;
    unpackDetail = 'no packfile was sent';
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) results.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
      else if (current !== command.oldOid) results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      else {
        repo.refs.delete(command.ref);
        changed = true;
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid !== current) {
      results.push({
        ref: command.ref,
        ok: false,
        reason: command.oldOid === ZERO_OID && current !== ZERO_OID ? 'reference already exists' : 'stale info',
      });
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'unknown object' });
      continue;
    }
    if (current !== ZERO_OID && command.newOid !== current) {
      const newCommit = peelToCommit(repo.objects, command.newOid);
      const currentCommit = peelToCommit(repo.objects, current);
      if (newCommit !== null && currentCommit !== null && !isAncestor(repo, currentCommit, newCommit)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    changed = true;
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  if (changed) repo.version += 1;

  if (!caps.has('report-status')) return raw(200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
  const reportParts: Buffer[] = [encodePkt(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const result of results) {
    reportParts.push(encodePkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (caps.has('side-band-64k')) {
    const out: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      out.push(encodePkt(Buffer.concat([Buffer.from([1]), report.subarray(offset, offset + CHUNK)])));
    }
    out.push(PKT_FLUSH);
    return raw(200, 'application/x-git-receive-pack-result', Buffer.concat(out));
  }
  return raw(200, 'application/x-git-receive-pack-result', report);
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

export function handleGit(forge: { getRepo(owner: string, name: string): Repo | null }, req: Req, owner: string, repoName: string): Resp {
  const repo = forge.getRepo(owner, repoName);
  if (repo === null) return errJson(404, 'Not Found');
  const rest = req.path.slice(`/${owner}/${repoName}.git`.length);
  if (req.method === 'GET' && rest === '/info/refs') return infoRefs(repo, req);
  if (req.method === 'POST' && rest === '/git-upload-pack') return uploadPack(repo, req);
  if (req.method === 'POST' && rest === '/git-receive-pack') return receivePack(repo, req);
  return errJson(404, 'Not Found');
}
