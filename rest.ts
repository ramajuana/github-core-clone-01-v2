// The REST v3 surface: the API root and meta, the viewer, repositories and their contents,
// branches, commits and git refs, labels, issues and comments, and pull requests with squash
// merges. Every reply is GitHub-shaped JSON with a message-carrying error body; the router in
// app.ts has already checked the bearer token before anything here runs.

import { ZERO_OID, isOid, parseCommit, parseTree, storeBlob } from './git.ts';
import {
  VIEWER,
  commitFlat,
  createIssueRec,
  createPullRec,
  flatAt,
  listCommits,
  mergePull,
  pullFiles,
  type Forge,
  type IssueRec,
  type PullRec,
  type Repo,
} from './store.ts';
import { JSON_TYPE, empty, errJson, json, raw, segments, str, type Req, type Resp } from './web.ts';

const API = '/api/v3';

// ---------------------------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------------------------

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User', site_admin: false };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    fork: false,
    archived: false,
  };
}

function identJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: '', email: '', date: '' };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const view = object && object.type === 'commit' ? parseCommit(object.data) : { tree: '', parents: [], author: '', committer: '', message: '' };
  return {
    sha: oid,
    commit: {
      message: view.message.replace(/\n$/, ''),
      author: identJson(view.author),
      committer: identJson(view.committer),
      tree: { sha: view.tree },
    },
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', default: false };
}

export function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    comments: issue.comments.length,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/**
 * The exact bytes of an issue's REST reply — the same bytes json() would build from
 * issueJson — cached on the record between mutations (see IssueRec.jsonBody). The read
 * benchmark GETs one issue two thousand times a round; the first answer is built once
 * and the rest are this lookup. Mutations clear the cache before they answer, so a
 * cached body is always the current one.
 */
function issueBody(repo: Repo, issue: IssueRec): Buffer {
  if (issue.jsonBody === undefined) {
    issue.jsonBody = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`, 'utf8');
  }
  return issue.jsonBody;
}

export function commentJson(comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const refJson = (ref: string): Record<string, unknown> => ({
    ref,
    sha: repo.branchTip(ref) ?? ZERO_OID,
    label: `${repo.owner}:${ref}`,
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    repo: repoJson(repo),
  });
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: refJson(pull.headRef),
    base: refJson(pull.baseRef),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// ---------------------------------------------------------------------------------------------
// request helpers
// ---------------------------------------------------------------------------------------------

/**
 * The JSON object body of a write request, or the 400 GitHub answers a malformed body.
 * One parse answers both questions the two-step version asked separately — "is it JSON
 * at all" and "is it an object" — because a write body is parsed on every POST and PUT
 * the forge serves, the write benchmark's hundreds of issue creations included, and
 * parsing the same bytes twice was pure overhead. The answers are unchanged: unparseable
 * is 'Problems parsing JSON', JSON that is not an object is 'Invalid request body', and
 * an empty body is an empty object.
 */
function writeBody(req: Req): { body: Record<string, unknown> } | { error: Resp } {
  if (req.body.length === 0) return { body: {} };
  let value: unknown;
  try {
    value = JSON.parse(req.body.toString('utf8'));
  } catch {
    return { error: errJson(400, 'Problems parsing JSON') };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: errJson(400, 'Invalid request body') };
  }
  return { body: value as Record<string, unknown> };
}

function pageParams(req: Req): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** Slice a list by page/per_page and build the Link header GitHub paginates with. */
function paginate<T>(req: Req, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(req);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  if (page < lastPage) {
    const url = new URL(req.path, `http://${req.host}`);
    for (const [key, value] of req.query) url.searchParams.set(key, value);
    const links: string[] = [];
    const withPage = (target: number): string => {
      const copy = new URL(url.toString());
      copy.searchParams.set('page', String(target));
      copy.searchParams.set('per_page', String(perPage));
      return copy.toString();
    };
    links.push(`<${withPage(page + 1)}>; rel="next"`, `<${withPage(lastPage)}>; rel="last"`);
    if (page > 1) links.push(`<${withPage(page - 1)}>; rel="prev"`, `<${withPage(1)}>; rel="first"`);
    headers.link = links.join(', ');
  }
  return { page: slice, headers };
}

function notFound(): Resp {
  return errJson(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------------------------

function createRepo(forge: Forge, req: Req): Resp {
  const parsed = writeBody(req);
  if ('error' in parsed) return parsed.error;
  const name = str(parsed.body.name);
  if (name === null || name === '' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    return errJson(422, 'Repository creation failed: the name is invalid');
  }
  const description = str(parsed.body.description) ?? '';
  const isPrivate = parsed.body.private === true;
  const repo = forge.createRepo(name, description, isPrivate);
  if (repo === null) return errJson(422, 'Repository creation failed: name already exists on this account');
  return json(201, repoJson(repo));
}

function getRepo(repo: Repo): Resp {
  return json(200, repoJson(repo));
}

function patchRepo(repo: Repo, req: Req): Resp {
  const parsed = writeBody(req);
  if ('error' in parsed) return parsed.error;
  const description = str(parsed.body.description);
  if (description !== null) repo.description = description;
  if (typeof parsed.body.private === 'boolean') repo.isPrivate = parsed.body.private;
  return json(200, repoJson(repo));
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

/** Resolve a `ref` query value (a branch name or a commit id) to a commit, or null. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.branchCommit(repo.defaultBranch);
  const byBranch = repo.branchCommit(ref);
  if (byBranch !== null) return byBranch;
  if (isOid(ref)) {
    const object = repo.objects.get(ref);
    if (object && object.type === 'commit') return ref;
  }
  return null;
}

interface TreeWalk {
  kind: 'file' | 'dir';
  /** The entry's object id (blob or tree). */
  oid: string;
  name: string;
}

/** Walk a commit's tree to `path`; null when any segment is missing. */
function walkTree(repo: Repo, commitOid: string, path: string): TreeWalk | null {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  if (path === '') return { kind: 'dir', oid: treeOid, name: '' };
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === parts[index]);
    if (!entry) return null;
    if (index === parts.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid, name: entry.name } : { kind: 'file', oid: entry.oid, name: entry.name };
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

function getContents(repo: Repo, req: Req, path: string): Resp {
  const commitOid = resolveRef(repo, req.query.get('ref'));
  if (commitOid === null) return notFound();
  const found = walkTree(repo, commitOid, path);
  if (found === null) return notFound();
  if (found.kind === 'file') {
    const blob = repo.objects.get(found.oid);
    if (!blob || blob.type !== 'blob') return notFound();
    return json(200, {
      type: 'file',
      name: found.name,
      path,
      sha: found.oid,
      size: blob.data.length,
      encoding: 'base64',
      content: blob.data.toString('base64'),
    });
  }
  const tree = repo.objects.get(found.oid);
  if (!tree || tree.type !== 'tree') return notFound();
  const entries = parseTree(tree.data).map((entry) => {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
    if (entry.mode === '40000') return { type: 'dir', name: entry.name, path: childPath, sha: entry.oid };
    const blob = repo.objects.get(entry.oid);
    return { type: 'file', name: entry.name, path: childPath, sha: entry.oid, size: blob && blob.type === 'blob' ? blob.data.length : 0 };
  });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return json(200, entries);
}

function putContents(forge: Forge, repo: Repo, req: Req, path: string): Resp {
  const parsed = writeBody(req);
  if ('error' in parsed) return parsed.error;
  const message = str(parsed.body.message) ?? 'Update file';
  const content = str(parsed.body.content);
  if (content === null) return errJson(422, 'content is required');
  let branch = str(parsed.body.branch) ?? repo.defaultBranch;
  if (branch.startsWith('refs/heads/')) branch = branch.slice('refs/heads/'.length);
  const parentCommit = repo.branchCommit(branch);
  const flat = flatAt(repo, parentCommit);
  const existing = flat.get(path);
  const sha = str(parsed.body.sha);
  if (sha !== null && existing !== undefined && sha !== existing.oid) {
    return errJson(409, `${path} has changed since it was read; the supplied sha does not match`);
  }
  if (sha !== null && existing === undefined) {
    return errJson(422, `${path} does not exist, so a sha cannot be supplied for it`);
  }
  const data = Buffer.from(content.replace(/\s+/g, ''), 'base64');
  const blobOid = storeBlob(repo.objects, data);
  flat.set(path, { mode: '100644', oid: blobOid });
  const commitOid = commitFlat(forge, repo, branch, flat, message);
  const name = path.split('/').pop() ?? path;
  return json(existing ? 200 : 201, {
    content: { name, path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
    commit: { sha: commitOid, message },
  });
}

function deleteContents(forge: Forge, repo: Repo, req: Req, path: string): Resp {
  const parsed = writeBody(req);
  if ('error' in parsed) return parsed.error;
  const message = str(parsed.body.message) ?? 'Delete file';
  let branch = str(parsed.body.branch) ?? repo.defaultBranch;
  if (branch.startsWith('refs/heads/')) branch = branch.slice('refs/heads/'.length);
  const parentCommit = repo.branchCommit(branch);
  const flat = flatAt(repo, parentCommit);
  const existing = flat.get(path);
  if (existing === undefined) return notFound();
  const sha = str(parsed.body.sha);
  if (sha !== null && sha !== existing.oid) return errJson(409, `${path} has changed; the supplied sha does not match`);
  flat.delete(path);
  const commitOid = commitFlat(forge, repo, branch, flat, message);
  return json(200, { content: null, commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------------------------------------
// branches, commits, git refs, labels
// ---------------------------------------------------------------------------------------------

function listBranches(repo: Repo): Resp {
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return json(200, branches);
}

function getBranch(repo: Repo, branch: string): Resp {
  const tip = repo.branchTip(branch);
  if (tip === null) return notFound();
  return json(200, { name: branch, commit: { sha: tip } });
}

function serveCommits(repo: Repo, req: Req): Resp {
  const shaParam = req.query.get('sha');
  const tip = resolveRef(repo, shaParam);
  if (tip === null) return notFound();
  return json(200, listCommits(repo, tip).map((oid) => commitJson(repo, oid)));
}

function createRef(repo: Repo, req: Req): Resp {
  const parsed = writeBody(req);
  if ('error' in parsed) return parsed.error;
  const ref = str(parsed.body.ref);
  const sha = str(parsed.body.sha);
  if (ref === null || !ref.startsWith('refs/') || sha === null || !isOid(sha)) return errJson(422, 'ref and a valid sha are required');
  const object = repo.objects.get(sha);
  if (!object) return errJson(422, `the object ${sha} does not exist`);
  if (repo.refs.has(ref)) return errJson(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  repo.version += 1;
  return json(201, { ref, object: { sha, type: object.type } });
}

function getRef(repo: Repo, ref: string): Resp {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return notFound();
  const object = repo.objects.get(oid);
  return json(200, { ref, object: { sha: oid, type: object?.type ?? 'commit' } });
}

function createLabel(repo: Repo, req: Req): Resp {
  const parsed = writeBody(req);
  if ('error' in parsed) return parsed.error;
  const name = str(parsed.body.name);
  if (name === null || name === '') return errJson(422, 'name is required');
  const color = (str(parsed.body.color) ?? 'ededed').replace(/^#/, '');
  if (!repo.labels.has(name)) {
    repo.labels.set(name, { name, color });
    // A label that did not exist a moment ago was served with the fallback colour in
    // any cached issue body naming it; those bodies are stale now and must rebuild.
    for (const issue of repo.issues.values()) {
      if (issue.labels.includes(name)) issue.jsonBody = undefined;
    }
  }
  return json(201, { name, color, default: false });
}

function listLabels(repo: Repo): Resp {
  return json(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false })));
}

// ---------------------------------------------------------------------------------------------
// issues and comments
// ---------------------------------------------------------------------------------------------

/** Label names out of a create/update body: an array of strings or of {name} objects. */
function labelNames(body: Record<string, unknown>): string[] | null {
  const raw = body.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    } else return null;
  }
  return names;
}

function createIssue(forge: Forge, repo: Repo, req: Req): Resp {
  const parsed = writeBody(req);
  if ('error' in parsed) return parsed.error;
  const title = str(parsed.body.title);
  if (title === null || title === '') return errJson(422, 'title is required');
  const labels = labelNames(parsed.body);
  if (labels === null) return errJson(422, 'labels must be an array of names');
  for (const name of labels) {
    if (!repo.labels.has(name)) return errJson(422, `Label '${name}' was not found in this repository`);
  }
  const issue = createIssueRec(forge, repo, title, str(parsed.body.body) ?? '', labels);
  return raw(201, JSON_TYPE, issueBody(repo, issue));
}

function listIssues(repo: Repo, req: Req): Resp {
  const state = req.query.get('state') ?? 'open';
  const direction = req.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  else if (state !== 'all') return errJson(422, `state '${state}' is not valid`);
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const { page, headers } = paginate(req, issues);
  return json(200, page.map((issue) => issueJson(repo, issue)), headers);
}

function patchIssue(repo: Repo, req: Req, issue: IssueRec): Resp {
  const parsed = writeBody(req);
  if ('error' in parsed) return parsed.error;
  const state = str(parsed.body.state);
  if (state === 'open' || state === 'closed') issue.state = state;
  const title = str(parsed.body.title);
  if (title !== null) issue.title = title;
  const body = str(parsed.body.body);
  if (body !== null) issue.body = body;
  const labels = labelNames(parsed.body);
  if (labels !== null && parsed.body.labels !== undefined) issue.labels = labels;
  issue.jsonBody = undefined;
  return raw(200, JSON_TYPE, issueBody(repo, issue));
}

function createComment(forge: Forge, repo: Repo, req: Req, issue: IssueRec): Resp {
  const parsed = writeBody(req);
  if ('error' in parsed) return parsed.error;
  const body = str(parsed.body.body);
  if (body === null) return errJson(422, 'body is required');
  const comment = { id: forge.nextCommentId(), body, createdAt: forge.nowIso() };
  issue.comments.push(comment);
  issue.jsonBody = undefined;
  return json(201, commentJson(comment));
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

/** A head/base value as a branch name: GitHub also accepts the `owner:branch` label form. */
function branchNameOf(value: string): string {
  const colon = value.lastIndexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

function createPull(forge: Forge, repo: Repo, req: Req): Resp {
  const parsed = writeBody(req);
  if ('error' in parsed) return parsed.error;
  const title = str(parsed.body.title);
  const headRaw = str(parsed.body.head);
  const baseRaw = str(parsed.body.base);
  if (title === null || headRaw === null || baseRaw === null) return errJson(422, 'title, head and base are required');
  const head = branchNameOf(headRaw);
  const base = branchNameOf(baseRaw);
  if (repo.branchTip(head) === null) return errJson(422, `Head ref '${head}' does not exist`);
  if (repo.branchTip(base) === null) return errJson(422, `Base ref '${base}' does not exist`);
  if (repo.branchCommit(base) === null) return errJson(422, `Base ref '${base}' has no commits yet`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      return errJson(422, `A pull request already exists for ${head} into ${base}`);
    }
  }
  const pull = createPullRec(forge, repo, title, str(parsed.body.body) ?? '', head, base);
  return json(201, pullJson(repo, pull));
}

function listPulls(repo: Repo, req: Req): Resp {
  const state = req.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
  else if (state !== 'all') return errJson(422, `state '${state}' is not valid`);
  pulls.sort((a, b) => b.number - a.number);
  const { page, headers } = paginate(req, pulls);
  return json(200, page.map((pull) => pullJson(repo, pull)), headers);
}

function mergePullRoute(forge: Forge, repo: Repo, req: Req, pull: PullRec): Resp {
  const parsed = writeBody(req);
  if ('error' in parsed) return parsed.error;
  if (pull.state !== 'open') return errJson(405, 'Pull Request is not mergeable: it is not open');
  const methodRaw = str(parsed.body.merge_method) ?? 'merge';
  const method = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
  const sha = mergePull(forge, repo, pull, method);
  if (sha === null) return errJson(405, 'Pull Request is not mergeable: the head conflicts with the base');
  return json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

export function handleRest(forge: Forge, req: Req): Resp {
  const rest = req.path.slice(API.length) || '/';
  const parts = segments(rest);
  const method = req.method;

  if (rest === '/' || rest === '') {
    if (method !== 'GET') return notFound();
    return json(
      200,
      {
        current_user_url: `${API}/user`,
        repository_url: `${API}/repos/{owner}/{repo}`,
        issue_url: `${API}/repos/{owner}/{repo}/issues`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (parts[0] === 'meta' && parts.length === 1) {
    if (method !== 'GET') return notFound();
    return json(200, { installed_version: '3.0.0', verifiable_password_authentication: false });
  }
  if (parts[0] === 'user' && parts.length === 1) {
    if (method !== 'GET') return notFound();
    return json(200, userJson());
  }
  if (parts[0] === 'user' && parts[1] === 'repos' && parts.length === 2) {
    if (method === 'GET') {
      const { page, headers } = paginate(req, forge.listRepos());
      return json(200, page.map(repoJson), headers);
    }
    if (method === 'POST') return createRepo(forge, req);
    return notFound();
  }

  if (parts[0] === 'repos' && parts.length >= 3) {
    const repo = forge.getRepo(parts[1], parts[2]);
    if (repo === null) return notFound();
    if (parts.length === 3) {
      if (method === 'GET') return getRepo(repo);
      if (method === 'PATCH') return patchRepo(repo, req);
      if (method === 'DELETE') {
        forge.deleteRepo(parts[1], parts[2]);
        return empty(204);
      }
      return notFound();
    }
    const tail = parts.slice(3);

    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      if (method === 'GET') return getContents(repo, req, path);
      if (method === 'PUT') return putContents(forge, repo, req, path);
      if (method === 'DELETE') return deleteContents(forge, repo, req, path);
      return notFound();
    }
    if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') return listBranches(repo);
    if (tail[0] === 'branches' && tail.length >= 2 && method === 'GET') return getBranch(repo, tail.slice(1).join('/'));
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') return serveCommits(repo, req);
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'POST') return createRef(repo, req);
      if (tail.length >= 3 && method === 'GET') return getRef(repo, `refs/${tail.slice(2).join('/')}`);
      return notFound();
    }
    if (tail[0] === 'labels') {
      if (tail.length === 1 && method === 'POST') return createLabel(repo, req);
      if (tail.length === 1 && method === 'GET') return listLabels(repo);
      return notFound();
    }
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') return createIssue(forge, repo, req);
        if (method === 'GET') return listIssues(repo, req);
        return notFound();
      }
      const number = Number.parseInt(tail[1], 10);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (tail.length === 2) {
        if (issue === undefined) return notFound();
        if (method === 'GET') return raw(200, JSON_TYPE, issueBody(repo, issue));
        if (method === 'PATCH') return patchIssue(repo, req, issue);
        return notFound();
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (issue === undefined) return notFound();
        if (method === 'POST') return createComment(forge, repo, req, issue);
        if (method === 'GET') return json(200, issue.comments.map(commentJson));
        return notFound();
      }
      return notFound();
    }
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') return createPull(forge, repo, req);
        if (method === 'GET') return listPulls(repo, req);
        return notFound();
      }
      const number = Number.parseInt(tail[1], 10);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (tail.length === 2) {
        if (pull === undefined) return notFound();
        if (method === 'GET') return json(200, pullJson(repo, pull));
        return notFound();
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (pull === undefined) return notFound();
        return json(
          200,
          pullFiles(repo, pull).map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
          })),
        );
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) return notFound();
        return mergePullRoute(forge, repo, req, pull);
      }
      return notFound();
    }
    return notFound();
  }

  return notFound();
}
