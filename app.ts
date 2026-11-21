// The forge's HTTP server: one process answering the health probe, the REST v3 surface, the
// GraphQL v4 endpoint, the MCP endpoint and git smart HTTP, all over one in-memory store. The
// bearer-token gate lives here: every /api and /mcp request must carry the trial's own token
// (MAKEFUN_SHOP_TOKEN) or it is a 401 with a GitHub-shaped body; /healthz and the git transport
// take none. Every response carries an X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './githttp.ts';
import { errJson, json, readBody, type Req, type Resp } from './web.ts';

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  const block = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0');
  return `${block(requestSeq & 0xffff)}:${block((requestSeq >> 4) & 0xffff)}:${block((requestSeq >> 8) & 0xffff)}:${block(requestSeq % 0xfff)}`;
}

// Shared by every request that arrives without a query string; handlers only ever read
// from a Req's query, never write to it, so one empty instance serves them all.
const NO_QUERY = new URLSearchParams();

// A path segment that is exactly "." or "..": the only shapes where the WHATWG URL
// parser's output differs from a plain split on "?", because it resolves dot segments.
const DOT_SEGMENT = /(^|\/)\.\.?($|\/)/;

/**
 * Split a request target into path and query. The suite's targets are origin-form
 * ("/api/v3/...?page=2"), and for those a split at the first "?" is exactly what the
 * URL parser would produce — the parser's only other effect on the path is resolving
 * dot segments, which no route here generates; a target that carries one (or is not
 * origin-form at all: an absolute URL, an OPTIONS "*") takes the parser path instead.
 * The split matters because this runs on every request the forge ever answers, the
 * read benchmark's thousands of GETs included, and the parser is the priciest part
 * of it after the socket itself.
 */
function splitTarget(target: string): { path: string; query: URLSearchParams } {
  if (!target.startsWith('/') || DOT_SEGMENT.test(target)) {
    const url = new URL(target, 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  }
  const mark = target.indexOf('?');
  if (mark === -1) return { path: target, query: NO_QUERY };
  return { path: target.slice(0, mark), query: new URLSearchParams(target.slice(mark + 1)) };
}

async function toReq(req: IncomingMessage): Promise<Req> {
  const { path, query } = splitTarget(req.url ?? '/');
  const headers = new Map<string, string>();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key.toLowerCase(), value);
  }
  return {
    method: req.method ?? 'GET',
    path,
    query,
    headers,
    body: await readBody(req),
    host: headers.get('host') ?? 'entry',
  };
}

function authorized(forge: Forge, req: Req): boolean {
  if (forge.token === '') return true;
  return req.headers.get('authorization') === `Bearer ${forge.token}`;
}

function route(forge: Forge, req: Req): Resp {
  if (req.method === 'GET' && req.path === '/healthz') return json(200, { ok: true });

  if (req.path === '/mcp') {
    if (!authorized(forge, req)) return errJson(401, 'Bad credentials');
    return handleMcp(forge, req);
  }
  if (req.path === '/api/graphql') {
    if (!authorized(forge, req)) return errJson(401, 'Bad credentials');
    return handleGraphql(forge, req);
  }
  if (req.path === '/api/v3' || req.path.startsWith('/api/v3/')) {
    if (!authorized(forge, req)) return errJson(401, 'Bad credentials');
    return handleRest(forge, req);
  }
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(req.path);
  if (gitMatch) {
    return handleGit(forge, req, gitMatch[1], gitMatch[2]);
  }
  return errJson(404, 'Not Found');
}

function send(res: ServerResponse, resp: Resp): void {
  const headers: Record<string, string> = {
    'content-type': resp.contentType,
    'x-github-request-id': nextRequestId(),
    ...resp.headers,
  };
  if (resp.status !== 204) headers['content-length'] = String(resp.body.length);
  res.writeHead(resp.status, headers);
  res.end(resp.body);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge(process.env.MAKEFUN_SHOP_TOKEN ?? '');
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const parsed = await toReq(req);
        send(res, route(forge, parsed));
      } catch {
        try {
          send(res, errJson(500, 'Internal Server Error'));
        } catch {
          // the socket is already gone; nothing more to do
        }
      }
    })();
  });
}
