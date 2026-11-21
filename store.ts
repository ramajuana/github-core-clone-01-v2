// The forge's in-memory state and the operations every surface shares: repositories with their git
// object store and refs, issues, comments, labels and pull requests, plus the three-way tree merge
// behind squash/merge and the tree diff behind a pull request's file list. One store serves REST,
// GraphQL, MCP and git smart HTTP alike, so an object created on one surface is the same object on
// every other. All timestamps come from a deterministic clock seeded by MAKEFUN_TRIAL_NOW, never
// from the wall clock, so a replayed trial sees identical bytes.

import {
  buildCommit,
  collectReachable,
  flattenTree,
  hashObject,
  parseCommit,
  refCommit,
  storeBlob,
  treeFromFlat,
  type FlatEntry,
  type GitObj,
  type Store,
} from './git.ts';

/** The token owner's identity: the one user of this forge (the suite's scenario viewer). */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  /**
   * The issue's REST serialization, cached as the exact response bytes (see issueBody in
   * rest.ts). The read benchmark asks for one issue thousands of times; rebuilding the object
   * graph and re-escaping its strings per request is the forge's hottest loop. Every mutation
   * of the record must clear this (patchIssue, both comment paths, the GraphQL close), and
   * createLabel clears it for issues carrying the label, whose colour the body embeds.
   */
  jsonBody?: Buffer;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LabelRec {
  name: string;
  color: string;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch = 'main';
  readonly objects: Store = new Map();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, LabelRec>();
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  nextNumber = 1;
  readonly createdAt: string;
  /**
   * Bumped on every change to the object store or the refs. The git transport caches
   * advertisements, ls-refs answers and fetch responses against this counter (see githttp.ts):
   * any write — a push, a contents commit, a merge, a ref creation — moves it, so a cached
   * answer can never outlive the state it was computed from.
   */
  version = 0;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, createdAt: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdAt = createdAt;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The commit a branch names (following tags), or null when the branch is unborn or absent. */
  branchCommit(branch: string): string | null {
    const tip = this.branchTip(branch);
    return tip === null ? null : refCommit(this.objects, tip);
  }
}

export class Forge {
  readonly token: string;
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private clockBaseMs: number;
  private clockTicks = 0;

  constructor(token: string) {
    this.token = token;
    const nowEnv = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = Date.parse(nowEnv);
    this.clockBaseMs = Number.isFinite(parsed) ? parsed : Date.UTC(2026, 0, 1, 0, 0, 0);
  }

  /** A deterministic timestamp: the trial's opening instant plus one second per call. */
  nowIso(): string {
    this.clockTicks += 1;
    return new Date(this.clockBaseMs + this.clockTicks * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  nowUnix(): number {
    return Math.floor(this.clockBaseMs / 1000) + this.clockTicks;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    this.repoSeq += 1;
    const repo = new Repo(this.repoSeq, VIEWER.login, name, description, isPrivate, this.nowIso());
    this.repos.set(name, repo);
    return repo;
  }

  /** A repo by owner/name; a foreign owner or an unknown name is a 404, never a 403. */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(name) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }
}

// ---------------------------------------------------------------------------------------------
// commits made through the API (contents writes, merges)
// ---------------------------------------------------------------------------------------------

/** Commit `flat` as the new tree of `branch`, on top of its current tip; answers the commit id. */
export function commitFlat(forge: Forge, repo: Repo, branch: string, flat: ReadonlyMap<string, FlatEntry>, message: string): string {
  const tree = treeFromFlat(repo.objects, flat);
  const parent = repo.branchCommit(branch);
  const data = buildCommit({
    tree,
    parents: parent === null ? [] : [parent],
    message,
    authorName: VIEWER.name,
    authorEmail: VIEWER.email,
    timestamp: forge.nowUnix(),
  });
  const oid = hashObject('commit', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.version += 1;
  return oid;
}

/** The flattened tree at a commit, or an empty map when the commit is null. */
export function flatAt(repo: Repo, commitOid: string | null): Map<string, FlatEntry> {
  if (commitOid === null) return new Map();
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return new Map();
  return flattenTree(repo.objects, parseCommit(commit.data).tree);
}

/** Create an issue record (shared by REST, GraphQL and MCP). Labels are validated by the caller. */
export function createIssueRec(forge: Forge, repo: Repo, title: string, body: string, labels: string[]): IssueRec {
  const now = forge.nowIso();
  const issue: IssueRec = {
    number: repo.nextNumber,
    id: forge.nextIssueId(),
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Create a pull request record; head/base shas are read live from the refs when serialized. */
export function createPullRec(forge: Forge, repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRec {
  const now = forge.nowIso();
  const pull: PullRec = {
    number: repo.nextNumber,
    id: forge.nextIssueId(),
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: now,
    updatedAt: now,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

// ---------------------------------------------------------------------------------------------
// merge: merge-base, three-way tree merge, and the pull-request file diff
// ---------------------------------------------------------------------------------------------

/** Every ancestor commit of `tip` with its shortest distance from the tip (the tip itself is 0). */
function ancestorDistances(repo: Repo, tip: string): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: Array<[string, number]> = [[tip, 0]];
  while (queue.length) {
    const [oid, distance] = queue.shift()!;
    if (distances.has(oid) && distances.get(oid)! <= distance) continue;
    distances.set(oid, distance);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push([parent, distance + 1]);
  }
  return distances;
}

/** The best common ancestor of two commits, or null when their histories do not meet. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = ancestorDistances(repo, a);
  const fromB = ancestorDistances(repo, b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, distanceA] of fromA) {
    const distanceB = fromB.get(oid);
    if (distanceB === undefined) continue;
    const score = distanceA + distanceB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

export interface MergeOutcome {
  ok: boolean;
  /** The merged tree id, present when ok. */
  tree?: string;
  /** The paths both sides changed incompatibly, present when not ok. */
  conflicts?: string[];
}

/**
 * Three-way merge of the head branch into the base branch, at tree granularity: a path changed on
 * only one side takes that side's version; a path changed identically on both sides is fine; a path
 * changed differently on both sides (including modify-versus-delete) conflicts.
 */
export function computeMerge(repo: Repo, headBranch: string, baseBranch: string): MergeOutcome {
  const headTip = repo.branchCommit(headBranch);
  const baseTip = repo.branchCommit(baseBranch);
  if (headTip === null || baseTip === null) return { ok: false, conflicts: [] };
  const base = mergeBase(repo, headTip, baseTip);
  const baseFlat = flatAt(repo, base);
  const headFlat = flatAt(repo, headTip);
  const intoFlat = flatAt(repo, baseTip);
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...intoFlat.keys()]);
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
    x === undefined && y === undefined ? true : x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode;
  for (const path of paths) {
    const atBase = baseFlat.get(path);
    const atHead = headFlat.get(path);
    const atInto = intoFlat.get(path);
    if (same(atHead, atInto)) {
      if (atHead) merged.set(path, atHead);
    } else if (same(atBase, atHead)) {
      if (atInto) merged.set(path, atInto);
    } else if (same(atBase, atInto)) {
      if (atHead) merged.set(path, atHead);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length) return { ok: false, conflicts };
  const tree = treeFromFlat(repo.objects, merged);
  return { ok: true, tree };
}

export type MergeMethod = 'squash' | 'merge' | 'rebase';

/**
 * Merge a pull request: compute the merge, commit it on the base branch (one squash commit, or a
 * two-parent merge commit), and mark the record merged. Returns the merge commit id, or null when
 * the merge conflicts or the pull is not open.
 */
export function mergePull(forge: Forge, repo: Repo, pull: PullRec, method: MergeMethod): string | null {
  if (pull.state !== 'open') return null;
  const outcome = computeMerge(repo, pull.headRef, pull.baseRef);
  if (!outcome.ok || outcome.tree === undefined) return null;
  const baseTip = repo.branchCommit(pull.baseRef);
  const headTip = repo.branchCommit(pull.headRef);
  if (baseTip === null || headTip === null) return null;
  let message: string;
  let parents: string[];
  if (method === 'merge') {
    message = `Merge pull request #${pull.number} from ${pull.headRef}`;
    parents = [baseTip, headTip];
  } else {
    message = `${pull.title} (#${pull.number})`;
    parents = [baseTip];
  }
  const data = buildCommit({
    tree: outcome.tree,
    parents,
    message,
    authorName: VIEWER.name,
    authorEmail: VIEWER.email,
    timestamp: forge.nowUnix(),
  });
  const oid = hashObject('commit', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
  repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
  repo.version += 1;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso();
  pull.mergeCommitSha = oid;
  pull.updatedAt = pull.mergedAt;
  return oid;
}

// ---------------------------------------------------------------------------------------------
// the pull-request file diff (merge-base tree versus head tree)
// ---------------------------------------------------------------------------------------------

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** Lines added/removed between two blobs, by a longest-common-subsequence over lines. */
function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  if (oldLines.length > 4000 || newLines.length > 4000) {
    return { additions: lineCount(newData), deletions: lineCount(oldData) };
  }
  const rows = oldLines.length;
  const cols = newLines.length;
  const dp = new Uint32Array((rows + 1) * (cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i * (cols + 1) + j] =
        oldLines[i] === newLines[j] ? dp[(i + 1) * (cols + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (cols + 1) + j], dp[i * (cols + 1) + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/** The files a pull request changes: merge-base tree versus head tree. */
export function pullFiles(repo: Repo, pull: PullRec): FileChange[] {
  const headTip = repo.branchCommit(pull.headRef);
  const baseTip = repo.branchCommit(pull.baseRef);
  if (headTip === null) return [];
  const base = baseTip === null ? null : mergeBase(repo, headTip, baseTip);
  const fromFlat = flatAt(repo, base);
  const toFlat = flatAt(repo, headTip);
  const paths = new Set<string>([...fromFlat.keys(), ...toFlat.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const from = fromFlat.get(path);
    const to = toFlat.get(path);
    if (from && to && from.oid === to.oid && from.mode === to.mode) continue;
    const blobData = (entry: FlatEntry | undefined): Buffer => {
      if (!entry) return Buffer.alloc(0);
      const object: GitObj | undefined = repo.objects.get(entry.oid);
      return object && object.type === 'blob' ? object.data : Buffer.alloc(0);
    };
    if (!from && to) {
      const additions = lineCount(blobData(to));
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (from && !to) {
      const deletions = lineCount(blobData(from));
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (from && to) {
      const { additions, deletions } = lineDiff(blobData(from), blobData(to));
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

/** True when `ancestor` is reachable from `descendant` through commit parents (fast-forward test). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** All commits reachable from a tip, newest first (by commit timestamp, then discovery order). */
export function listCommits(repo: Repo, tip: string): string[] {
  const reachable = collectReachable(repo.objects, [tip], { allowMissing: true });
  const commits: Array<{ oid: string; timestamp: number; order: number }> = [];
  let order = 0;
  for (const oid of reachable) {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const view = parseCommit(object.data);
    const match = / (\d+) [+-]\d{4}$/.exec(view.committer);
    commits.push({ oid, timestamp: match ? Number(match[1]) : 0, order: order++ });
  }
  commits.sort((a, b) => b.timestamp - a.timestamp || a.order - b.order);
  return commits.map((entry) => entry.oid);
}

export { storeBlob };
