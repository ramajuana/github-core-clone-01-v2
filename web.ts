// Shared HTTP plumbing for the forge's surfaces: a parsed request, a response value, and the JSON
// helpers every surface answers with. Handlers are pure functions from (forge, request) to a
// response value; app.ts owns the socket, the request id and the auth gate.

import type { IncomingMessage } from 'node:http';

export interface Req {
  method: string;
  /** The decoded path, no query string. */
  path: string;
  query: URLSearchParams;
  headers: ReadonlyMap<string, string>;
  body: Buffer;
  /** The request's Host header: the origin pagination Link URLs must stay on. */
  host: string;
}

export interface Resp {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Readonly<Record<string, string>>;
}

export const JSON_TYPE = 'application/json; charset=utf-8';

export function json(status: number, value: unknown, headers?: Readonly<Record<string, string>>): Resp {
  return { status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), headers };
}

/** GitHub's error shape: a JSON object with a non-empty string message. */
export function errJson(status: number, message: string): Resp {
  return json(status, { message });
}

export function empty(status: number): Resp {
  return { status, contentType: JSON_TYPE, body: Buffer.alloc(0) };
}

export function raw(status: number, contentType: string, body: Buffer): Resp {
  return { status, contentType, body };
}

/** Parse a JSON request body; null when the body is not a JSON object. */
export function jsonBody(req: Req): Record<string, unknown> | null {
  if (req.body.length === 0) return null;
  try {
    const value = JSON.parse(req.body.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Whether the body parses as JSON at all (the protocol check posts malformed JSON). */
export function bodyIsJson(req: Req): boolean {
  if (req.body.length === 0) return true;
  try {
    JSON.parse(req.body.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

const EMPTY_BODY: Buffer = Buffer.alloc(0);

/** Read a request body whole, with a generous cap; rejects past the cap. */
export async function readBody(req: IncomingMessage, cap = 256 * 1024 * 1024): Promise<Buffer> {
  // Most requests the forge serves carry no body at all (every GET, including the read
  // benchmark's thousands of issue reads and every info/refs). HTTP says so up front —
  // neither a Content-Length nor a Transfer-Encoding — and answering from the headers
  // skips the stream machinery the general path below pays per request. A declared
  // Content-Length of 0 is the same fact stated the other way.
  const length = req.headers['content-length'];
  if ((length === undefined || length === '0') && req.headers['transfer-encoding'] === undefined) {
    return EMPTY_BODY;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > cap) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Split a path into decoded segments. */
export function segments(path: string): string[] {
  return path
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}
