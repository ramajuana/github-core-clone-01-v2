// A small GraphQL engine for the v4 surface: a tokenizer and parser for the document shapes gh
// and github-mcp-server send (operations with variables, aliases, inline fragments, enum and
// input-object argument values, batching at the HTTP layer), and an executor over the forge's
// store with the schema the conformance suite probes. Unknown fields are GraphQL errors in a 200,
// never HTTP errors; unknown repositories are null data, not errors.

import { computeMerge, createIssueRec, createPullRec, mergePull, pullFiles, VIEWER, type Forge, type Repo } from './store.ts';
import { json, type Req, type Resp } from './web.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type TokKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';
interface Tok {
  kind: TokKind;
  value: string;
}

function tokenize(source: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.startsWith('...', i)) {
      toks.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      toks.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        toks.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      toks.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      toks.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let kind: TokKind = 'int';
      if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') {
        kind = 'float';
        if (source[j] === '.') {
          j += 1;
          while (j < source.length && /[0-9]/.test(source[j])) j += 1;
        }
        if (source[j] === 'e' || source[j] === 'E') {
          j += 1;
          if (source[j] === '+' || source[j] === '-') j += 1;
          while (j < source.length && /[0-9]/.test(source[j])) j += 1;
        }
      }
      toks.push({ kind, value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  toks.push({ kind: 'eof', value: '' });
  return toks;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

export type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<[string, GqlValue]> };

export type SelNode =
  | { kind: 'field'; name: string; alias: string | null; args: Array<[string, GqlValue]>; selection: SelNode[] | null }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string; selection: SelNode[] };

export interface Operation {
  op: 'query' | 'mutation';
  name: string | null;
  selection: SelNode[];
}

interface FragmentDef {
  typeCondition: string;
  selection: SelNode[];
}

class Parser {
  private toks: Tok[];
  private pos = 0;

  constructor(source: string) {
    this.toks = tokenize(source);
  }

  private peek(): Tok {
    return this.toks[this.pos];
  }

  private next(): Tok {
    return this.toks[this.pos++];
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected '${value}', got '${tok.value}'`);
  }

  private skipPunct(value: string): boolean {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`expected a name, got '${tok.value}'`);
    return tok.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDef> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ op: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind !== 'name') throw new Error(`unexpected token '${tok.value}'`);
      if (tok.value === 'query' || tok.value === 'mutation') {
        const op = tok.value;
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefs();
        this.parseDirectives();
        operations.push({ op, name, selection: this.parseSelectionSet() });
        continue;
      }
      if (tok.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        if (this.expectName() !== 'on') throw new Error('expected `on` in a fragment definition');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unsupported definition '${tok.value}'`);
    }
    return { operations, fragments };
  }

  private parseVariableDefs(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.parseDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Array<[string, GqlValue]> {
    const args: Array<[string, GqlValue]> = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push([name, this.parseValue()]);
    }
    return args;
  }

  private parseValue(): GqlValue {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'var', name: this.expectName() };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: Number.parseInt(tok.value, 10) };
    if (tok.kind === 'float') return { kind: 'float', value: Number.parseFloat(tok.value) };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: GqlValue[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Array<[string, GqlValue]> = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push([name, this.parseValue()]);
      }
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'bool', value: true };
      if (tok.value === 'false') return { kind: 'bool', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`unexpected value token '${tok.value}'`);
  }

  private parseSelectionSet(): SelNode[] {
    this.expectPunct('{');
    const selections: SelNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.parseDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    this.parseDirectives();
    const selection = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, selection };
  }
}

// ---------------------------------------------------------------------------------------------
// global ids: opaque, stable, and decodable by node(id:) and the mutation inputs
// ---------------------------------------------------------------------------------------------

function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`v1:${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

function decodeGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const match = /^v1:([A-Za-z]+):(.*)$/.exec(text);
    if (!match) return null;
    return { kind: match[1], parts: match[2].split(':') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// execution context and tagged values
// ---------------------------------------------------------------------------------------------

type Tagged = { __type: string; [key: string]: unknown };

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string }>;
}

class GqlError extends Error {}

function evalValue(value: GqlValue, ctx: Ctx): unknown {
  switch (value.kind) {
    case 'var':
      return ctx.variables[value.name] ?? null;
    case 'string':
    case 'enum':
      return value.value;
    case 'int':
    case 'float':
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => evalValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = evalValue(inner, ctx);
      return out;
    }
  }
}

function evalArgs(args: Array<[string, GqlValue]>, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of args) out[key] = evalValue(value, ctx);
  return out;
}

function repoById(forge: Forge, id: number): Repo | null {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return null;
}

function tagRepo(repo: Repo): Tagged {
  return { __type: 'Repository', repo };
}

function tagIssue(repo: Repo, issue: { number: number }): Tagged {
  const found = repo.issues.get(issue.number);
  return { __type: 'Issue', repo, issue: found };
}

function tagPull(repo: Repo, pull: { number: number }): Tagged {
  const found = repo.pulls.get(pull.number);
  return { __type: 'PullRequest', repo, pull: found };
}

// ---------------------------------------------------------------------------------------------
// the schema: field types and resolvers per type
// ---------------------------------------------------------------------------------------------

interface FieldDef {
  /** The named return type (list brackets are stripped by the executor). */
  type: string;
  resolve?: (parent: Tagged | null, args: Record<string, unknown>, ctx: Ctx) => unknown;
}

type Schema = Record<string, Record<string, FieldDef>>;

const str = (parent: Tagged | null, key: string): unknown => (parent === null ? null : (parent[key] as unknown) ?? null);

const SCHEMA: Schema = {
  Query: {
    viewer: { type: 'User', resolve: () => ({ __type: 'User' }) },
    repository: {
      type: 'Repository',
      resolve: (_parent, args, ctx) => {
        const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : tagRepo(repo);
      },
    },
    node: {
      type: 'Node',
      resolve: (_parent, args, ctx) => {
        const decoded = decodeGid(String(args.id ?? ''));
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = repoById(ctx.forge, Number(decoded.parts[0]));
          return repo === null ? null : tagRepo(repo);
        }
        if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
          const repo = repoById(ctx.forge, Number(decoded.parts[0]));
          if (repo === null) return null;
          const number = Number(decoded.parts[1]);
          return decoded.kind === 'Issue' ? (repo.issues.has(number) ? tagIssue(repo, { number }) : null) : repo.pulls.has(number) ? tagPull(repo, { number }) : null;
        }
        return null;
      },
    },
    __type: {
      type: '__Type',
      resolve: (_parent, args) => typeDefOf(String(args.name ?? '')),
    },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGid(String(input.repositoryId ?? ''));
        const repo = decoded?.kind === 'Repository' ? repoById(ctx.forge, Number(decoded.parts[0])) : null;
        if (repo === null) throw new GqlError('repositoryId does not name a repository');
        const issue = createIssueRec(ctx.forge, repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { __type: 'CreateIssuePayload', issue: tagIssue(repo, issue) };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGid(String(input.issueId ?? ''));
        const repo = decoded?.kind === 'Issue' ? repoById(ctx.forge, Number(decoded.parts[0])) : null;
        const issue = repo?.issues.get(Number(decoded?.parts[1]));
        if (!repo || !issue) throw new GqlError('issueId does not name an issue');
        issue.state = 'closed';
        issue.updatedAt = ctx.forge.nowIso();
        issue.jsonBody = undefined;
        return { __type: 'CloseIssuePayload', issue: tagIssue(repo, issue) };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGid(String(input.repositoryId ?? ''));
        const repo = decoded?.kind === 'Repository' ? repoById(ctx.forge, Number(decoded.parts[0])) : null;
        if (repo === null) throw new GqlError('repositoryId does not name a repository');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        if (repo.branchTip(head) === null) throw new GqlError(`head ref '${head}' does not exist`);
        if (repo.branchTip(base) === null) throw new GqlError(`base ref '${base}' does not exist`);
        const pull = createPullRec(ctx.forge, repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
        return { __type: 'CreatePullRequestPayload', pullRequest: tagPull(repo, pull) };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGid(String(input.pullRequestId ?? ''));
        const repo = decoded?.kind === 'PullRequest' ? repoById(ctx.forge, Number(decoded.parts[0])) : null;
        const pull = repo?.pulls.get(Number(decoded?.parts[1]));
        if (!repo || !pull) throw new GqlError('pullRequestId does not name a pull request');
        const methodRaw = String(input.mergeMethod ?? 'SQUASH');
        const method = methodRaw === 'MERGE' ? 'merge' : 'squash';
        const sha = mergePull(ctx.forge, repo, pull, method);
        if (sha === null) throw new GqlError('the pull request is not mergeable');
        return { __type: 'MergePullRequestPayload', pullRequest: tagPull(repo, pull) };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGid(String(input.subjectId ?? ''));
        const repo = decoded?.kind === 'Issue' ? repoById(ctx.forge, Number(decoded.parts[0])) : null;
        const issue = repo?.issues.get(Number(decoded?.parts[1]));
        if (!repo || !issue) throw new GqlError('subjectId does not name an issue');
        const comment = { id: ctx.forge.nextCommentId(), body: String(input.body ?? ''), createdAt: ctx.forge.nowIso() };
        issue.comments.push(comment);
        issue.jsonBody = undefined;
        const node: Tagged = { __type: 'IssueComment', id: gid('IssueComment', repo.id, issue.number, comment.id), body: comment.body };
        return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node } };
      },
    },
  },
  User: {
    login: { type: 'String', resolve: () => VIEWER.login },
    id: { type: 'ID', resolve: () => gid('User', VIEWER.id) },
    name: { type: 'String', resolve: () => VIEWER.name },
  },
  Node: {
    id: { type: 'ID', resolve: (parent) => (parent === null ? null : parent.id) },
  },
  Ref: {
    name: { type: 'String', resolve: (parent) => str(parent, 'name') },
  },
  Repository: {
    id: { type: 'ID', resolve: (parent) => gid('Repository', (parent!.repo as Repo).id) },
    databaseId: { type: 'Int', resolve: (parent) => (parent!.repo as Repo).id },
    name: { type: 'String', resolve: (parent) => (parent!.repo as Repo).name },
    nameWithOwner: { type: 'String', resolve: (parent) => (parent!.repo as Repo).fullName },
    description: { type: 'String', resolve: (parent) => (parent!.repo as Repo).description },
    isPrivate: { type: 'Boolean', resolve: (parent) => (parent!.repo as Repo).isPrivate },
    owner: { type: 'User', resolve: () => ({ __type: 'User' }) },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (parent) => {
        const repo = parent!.repo as Repo;
        return repo.branchTip(repo.defaultBranch) === null ? null : { __type: 'Ref', name: repo.defaultBranch };
      },
    },
    viewerPermission: { type: 'String', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    issue: {
      type: 'Issue',
      resolve: (parent, args) => {
        const repo = parent!.repo as Repo;
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined ? null : tagIssue(repo, issue);
      },
    },
    issues: {
      type: 'IssueConnection',
      resolve: (parent, args) => {
        const repo = parent!.repo as Repo;
        let issues = [...repo.issues.values()];
        const states = args.states as unknown[] | null | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | null | undefined;
        const descending = orderBy?.direction === 'DESC';
        issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
        const first = typeof args.first === 'number' ? args.first : 100;
        let start = 0;
        if (typeof args.after === 'string' && args.after !== '') {
          const decoded = decodeGid(args.after);
          if (decoded?.kind === 'Cursor') start = Number(decoded.parts[0]) || 0;
        }
        const slice = issues.slice(start, start + first);
        return {
          __type: 'IssueConnection',
          nodes: slice.map((issue) => tagIssue(repo, issue)),
          pageInfo: {
            __type: 'PageInfo',
            hasNextPage: start + slice.length < issues.length,
            endCursor: gid('Cursor', start + slice.length),
          },
        };
      },
    },
    pullRequest: {
      type: 'PullRequest',
      resolve: (parent, args) => {
        const repo = parent!.repo as Repo;
        const pull = repo.pulls.get(Number(args.number));
        return pull === undefined ? null : tagPull(repo, pull);
      },
    },
    pullRequests: {
      type: 'PullRequestConnection',
      resolve: (parent, args) => {
        const repo = parent!.repo as Repo;
        const first = typeof args.first === 'number' ? args.first : 100;
        const pulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open').sort((a, b) => b.number - a.number);
        return { __type: 'PullRequestConnection', nodes: pulls.slice(0, first).map((pull) => tagPull(repo, pull)) };
      },
    },
  },
  Issue: {
    id: { type: 'ID', resolve: (parent) => gid('Issue', (parent!.repo as Repo).id, (parent!.issue as { number: number }).number) },
    number: { type: 'Int', resolve: (parent) => (parent!.issue as { number: number }).number },
    title: { type: 'String', resolve: (parent) => (parent!.issue as { title: string }).title },
    body: { type: 'String', resolve: (parent) => (parent!.issue as { body: string }).body },
    state: { type: 'String', resolve: (parent) => ((parent!.issue as { state: string }).state === 'open' ? 'OPEN' : 'CLOSED') },
  },
  PullRequest: {
    id: { type: 'ID', resolve: (parent) => gid('PullRequest', (parent!.repo as Repo).id, (parent!.pull as { number: number }).number) },
    number: { type: 'Int', resolve: (parent) => (parent!.pull as { number: number }).number },
    title: { type: 'String', resolve: (parent) => (parent!.pull as { title: string }).title },
    body: { type: 'String', resolve: (parent) => (parent!.pull as { body: string }).body },
    state: {
      type: 'String',
      resolve: (parent) => {
        const pull = parent!.pull as { state: string; merged: boolean };
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      },
    },
    merged: { type: 'Boolean', resolve: (parent) => (parent!.pull as { merged: boolean }).merged },
    headRefName: { type: 'String', resolve: (parent) => (parent!.pull as { headRef: string }).headRef },
    baseRefName: { type: 'String', resolve: (parent) => (parent!.pull as { baseRef: string }).baseRef },
    mergeable: {
      type: 'String',
      resolve: (parent) => {
        const repo = parent!.repo as Repo;
        const pull = parent!.pull as { state: string; headRef: string; baseRef: string };
        if (pull.state !== 'open') return 'UNKNOWN';
        return computeMerge(repo, pull.headRef, pull.baseRef).ok ? 'MERGEABLE' : 'CONFLICTING';
      },
    },
    files: {
      type: 'PullRequestChangedFileConnection',
      resolve: (parent, args) => {
        const repo = parent!.repo as Repo;
        const pull = parent!.pull as Parameters<typeof pullFiles>[1];
        const first = typeof args.first === 'number' ? args.first : 100;
        return {
          __type: 'PullRequestChangedFileConnection',
          nodes: pullFiles(repo, pull)
            .slice(0, first)
            .map((file) => ({ __type: 'PullRequestChangedFile', path: file.filename })),
        };
      },
    },
  },
  IssueConnection: {
    nodes: { type: 'Issue', resolve: (parent) => str(parent, 'nodes') },
    pageInfo: { type: 'PageInfo', resolve: (parent) => str(parent, 'pageInfo') },
  },
  PullRequestConnection: {
    nodes: { type: 'PullRequest', resolve: (parent) => str(parent, 'nodes') },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: 'PullRequestChangedFile', resolve: (parent) => str(parent, 'nodes') },
  },
  PullRequestChangedFile: {
    path: { type: 'String', resolve: (parent) => str(parent, 'path') },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean', resolve: (parent) => str(parent, 'hasNextPage') },
    endCursor: { type: 'String', resolve: (parent) => str(parent, 'endCursor') },
  },
  CreateIssuePayload: { issue: { type: 'Issue', resolve: (parent) => str(parent, 'issue') } },
  CloseIssuePayload: { issue: { type: 'Issue', resolve: (parent) => str(parent, 'issue') } },
  CreatePullRequestPayload: { pullRequest: { type: 'PullRequest', resolve: (parent) => str(parent, 'pullRequest') } },
  MergePullRequestPayload: { pullRequest: { type: 'PullRequest', resolve: (parent) => str(parent, 'pullRequest') } },
  AddCommentPayload: { commentEdge: { type: 'CommentEdge', resolve: (parent) => str(parent, 'commentEdge') } },
  CommentEdge: { node: { type: 'IssueComment', resolve: (parent) => str(parent, 'node') } },
  IssueComment: {
    id: { type: 'ID', resolve: (parent) => str(parent, 'id') },
    body: { type: 'String', resolve: (parent) => str(parent, 'body') },
  },
  __Type: {
    name: { type: 'String', resolve: (parent) => str(parent, 'name') },
    kind: { type: 'String', resolve: (parent) => str(parent, 'kind') },
    fields: { type: '__Field', resolve: (parent) => str(parent, 'fields') },
    enumValues: { type: '__EnumValue', resolve: (parent) => str(parent, 'enumValues') },
  },
  __Field: { name: { type: 'String', resolve: (parent) => str(parent, 'name') } },
  __EnumValue: { name: { type: 'String', resolve: (parent) => str(parent, 'name') } },
};

// ---------------------------------------------------------------------------------------------
// introspection data
// ---------------------------------------------------------------------------------------------

const TYPE_DEFS: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels', 'repository', 'createdAt', 'updatedAt', 'url', 'closedAt'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files',
      'author', 'repository', 'createdAt', 'updatedAt', 'url', 'additions', 'deletions', 'changedFiles', 'commits', 'mergedAt',
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
      'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url',
    ],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
};

function typeDefOf(name: string): Tagged | null {
  const def = TYPE_DEFS[name];
  if (!def) return null;
  return {
    __type: '__Type',
    name,
    kind: def.kind,
    fields: def.fields ? def.fields.map((field) => ({ __type: '__Field', name: field })) : null,
    enumValues: def.enumValues ? def.enumValues.map((value) => ({ __type: '__EnumValue', name: value })) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// the executor
// ---------------------------------------------------------------------------------------------

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

function executeSelectionSet(typeName: string, parent: Tagged | null, selections: SelNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const effectiveType = parent !== null && typeof parent.__type === 'string' ? parent.__type : typeName;
  for (const node of selections) {
    if (node.kind === 'spread') {
      const fragment = ctx.fragments.get(node.name);
      if (fragment && (fragment.typeCondition === effectiveType || fragment.typeCondition === typeName)) {
        Object.assign(out, executeSelectionSet(fragment.typeCondition, parent, fragment.selection, ctx));
      }
      continue;
    }
    if (node.kind === 'inline') {
      if (node.typeCondition === effectiveType || node.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(node.typeCondition, parent, node.selection, ctx));
      }
      continue;
    }
    const key = node.alias ?? node.name;
    if (node.name === '__typename') {
      out[key] = effectiveType;
      continue;
    }
    const fieldDef = SCHEMA[effectiveType]?.[node.name] ?? SCHEMA[typeName]?.[node.name];
    if (!fieldDef) {
      ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type '${effectiveType}'` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = fieldDef.resolve ? fieldDef.resolve(parent, evalArgs(node.args, ctx), ctx) : str(parent, node.name);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, fieldDef.type, node.selection, ctx);
  }
  return out;
}

function completeValue(value: unknown, typeName: string, selection: SelNode[] | null, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, typeName, selection, ctx));
  if (selection === null || SCALARS.has(typeName)) return value;
  if (typeof value === 'object') return executeSelectionSet(typeName, value as Tagged, selection, ctx);
  return value;
}

function executeOperation(forge: Forge, operation: Operation, fragments: Map<string, FragmentDef>, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { forge, variables, fragments, errors: [] };
  const rootType = operation.op === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, null, operation.selection, ctx);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

// ---------------------------------------------------------------------------------------------
// the HTTP route
// ---------------------------------------------------------------------------------------------

function executeOne(forge: Forge, body: Record<string, unknown>): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  try {
    const { operations, fragments } = new Parser(query).parseDocument();
    const operation = operationName !== null ? operations.find((op) => op.name === operationName) : operations[0];
    if (!operation) return { data: null, errors: [{ message: 'no operation to execute' }] };
    return executeOperation(forge, operation, fragments, variables);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

export function handleGraphql(forge: Forge, req: Req): Resp {
  if (req.method !== 'POST') return json(404, { message: 'Not Found' });
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return json(400, { errors: [{ message: 'the request body is not JSON' }] });
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) =>
      typeof entry === 'object' && entry !== null ? executeOne(forge, entry as Record<string, unknown>) : { data: null, errors: [{ message: 'invalid operation' }] },
    );
    return json(200, results);
  }
  if (typeof body !== 'object' || body === null) return json(400, { errors: [{ message: 'the request body must be an operation object' }] });
  return json(200, executeOne(forge, body as Record<string, unknown>));
}
