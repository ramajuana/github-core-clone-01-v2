// The MCP endpoint at /mcp: JSON-RPC 2.0 over streamable HTTP, speaking the current 2026-07-28
// revision (server/discover, no handshake, no session) and answering initialize for handshake-era
// clients. The six tools drive the same store as REST and GraphQL, so an object created here is
// the same object everywhere. The tool list is a module constant: two tools/list calls answer
// byte-identical arrays.

import { issueJson, pullJson, repoJson } from './rest.ts';
import { createIssueRec, createPullRec, mergePull, type Forge, type Repo } from './store.ts';
import { VIEWER } from './store.ts';
import { json, type Req, type Resp } from './web.ts';

const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

const TOOL_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
}));

// ---------------------------------------------------------------------------------------------
// tool execution
// ---------------------------------------------------------------------------------------------

type ToolOutcome = { ok: true; payload: unknown } | { ok: false; message: string };

function repoArg(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  return forge.getRepo(owner, repo);
}

function runTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      if (!/^[A-Za-z0-9._-]+$/.test(repoName)) return { ok: false, message: `invalid repository name '${repoName}'` };
      const repo = forge.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      if (repo === null) return { ok: false, message: `repository '${repoName}' already exists` };
      return { ok: true, payload: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = repoArg(forge, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      return { ok: true, payload: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = repoArg(forge, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      const issue = createIssueRec(forge, repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      return { ok: true, payload: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const repo = repoArg(forge, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      return { ok: true, payload: issues.map((issue) => issueJson(repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = repoArg(forge, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      if (repo.branchTip(head) === null) return { ok: false, message: `head branch '${head}' does not exist` };
      if (repo.branchTip(base) === null) return { ok: false, message: `base branch '${base}' does not exist` };
      const pull = createPullRec(forge, repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, base);
      return { ok: true, payload: pullJson(repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = repoArg(forge, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return { ok: false, message: `pull request ${String(args.pull_number)} not found` };
      const sha = mergePull(forge, repo, pull, 'squash');
      if (sha === null) return { ok: false, message: 'the pull request is not mergeable' };
      return { ok: true, payload: { ...pullJson(repo, pull), sha } };
    }
    default:
      return { ok: false, message: `unknown tool '${name}'` };
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): Resp {
  return json(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): Resp {
  return json(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolResult(id: unknown, outcome: ToolOutcome): Resp {
  if (!outcome.ok) {
    return rpcResult(id, { content: [{ type: 'text', text: outcome.message }], isError: true });
  }
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
    structuredContent: outcome.payload,
    isError: false,
  });
}

function handleOne(forge: Forge, message: Record<string, unknown>): Resp | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
  if (id === undefined) return null; // a notification: accepted, never answered

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: REVISIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return rpcResult(id, {
        protocolVersion: REVISIONS.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOL_LIST });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return rpcError(id, -32602, `unknown tool '${name}'`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return rpcResult(id, { content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }], isError: true });
      }
      return toolResult(id, runTool(forge, name, args));
    }
    default:
      return rpcError(id, -32601, `method '${method}' not found`);
  }
}

export function handleMcp(forge: Forge, req: Req): Resp {
  if (req.method === 'GET' || req.method === 'DELETE') return json(405, { message: 'Method Not Allowed' });
  if (req.method !== 'POST') return json(405, { message: 'Method Not Allowed' });
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body is not JSON' } });
  }
  if (Array.isArray(body)) {
    const answers: unknown[] = [];
    for (const entry of body) {
      if (typeof entry !== 'object' || entry === null) continue;
      const answer = handleOne(forge, entry as Record<string, unknown>);
      if (answer !== null) answers.push(JSON.parse(answer.body.toString('utf8')));
    }
    return json(200, answers);
  }
  if (typeof body !== 'object' || body === null) {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const answer = handleOne(forge, body as Record<string, unknown>);
  if (answer === null) return { status: 202, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
  return answer;
}

export { VIEWER };
