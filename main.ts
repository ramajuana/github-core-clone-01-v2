// The forge's entry point: the harness handshake, nothing more.
//
// The harness owns the trial clock. It hands us its base URL in
// MAKEFUN_ENV_URL, waits for this process to POST the port the forge bound,
// drives the forge over HTTP and git until the suite is finished, and then
// answers the done poll with {"done": true} — at which point we close the
// server and exit 0. Every forge behaviour lives behind createApp() in
// app.ts; this file only speaks to the harness.

import { createApp } from './app.ts';

// One harness request may hang at most this long before it counts as failed.
const HARNESS_TIMEOUT_MS = 30_000;

// The retry cadence shared by the register and done loops: start at a
// quarter second, double after every failure, and cap at two seconds so a
// long trial never polls less often than that.
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

// How long shutdown may take before lingering connections are destroyed
// (see the close at the end of main): long enough for any in-flight reply
// to flush, far short of anything the trial's wall would notice.
const SHUTDOWN_GRACE_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Successive waits of the backoff schedule described above.
class RetryPace {
  private next: number = RETRY_FIRST_MS;

  async wait(): Promise<void> {
    await delay(this.next);
    this.next = Math.min(this.next * 2, RETRY_CAP_MS);
  }
}

// Announce our port to the harness until it takes the registration.
//
// A 200 (registered) or 409 (someone registered first, which the contract
// counts as registered) ends the loop. A 400 or 405 condemns the request
// itself, so retrying is pointless: fail at once with the body attached.
// Anything else — a 5xx, a reset, a timeout — is treated as transient and
// retried on the backoff schedule for as long as it takes.
async function registerWithHarness(baseUrl: string, port: number): Promise<void> {
  const pace = new RetryPace();
  const body = JSON.stringify({ port });
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(HARNESS_TIMEOUT_MS),
      });
    } catch {
      await pace.wait();
      continue;
    }
    if (response.status === 200 || response.status === 409) return;
    if (response.status === 400 || response.status === 405) {
      throw new Error(`harness refused the registration (${response.status}): ${await response.text()}`);
    }
    // Consume the body so the connection returns to the pool, then retry.
    await response.text().catch(() => undefined);
    await pace.wait();
  }
}

// Poll the harness's done flag until it answers exactly {"done": true}.
// Every other outcome — unreachable, non-2xx, unparseable, or a payload
// whose done is not true — means "not yet" and simply costs one backoff
// wait. This returns only on a positive answer.
async function awaitHarnessDone(baseUrl: string): Promise<void> {
  const pace = new RetryPace();
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/done`, {
        signal: AbortSignal.timeout(HARNESS_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload: unknown = await response.json();
        if (typeof payload === 'object' && payload !== null && (payload as { done?: unknown }).done === true) {
          return;
        }
      } else {
        await response.text().catch(() => undefined);
      }
    } catch {
      // A failed poll says nothing beyond "not done yet".
    }
    await pace.wait();
  }
}

async function main(): Promise<void> {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') {
    console.error('MAKEFUN_ENV_URL is unset or empty; there is no harness to register with.');
    process.exit(1);
  }

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the forge server did not bind to a TCP port');
  }
  console.log(`forge listening on port ${bound.port}`);

  await registerWithHarness(envUrl, bound.port);
  console.log(`registered port ${bound.port} with the harness at ${envUrl}`);

  await awaitHarnessDone(envUrl);
  console.log('harness reports the trial done; shutting down');

  // Close gracefully, but never let the close itself eat the trial's wall:
  // the harness flips done only after its export is written, so once it has
  // answered, leaving promptly is always safe — while a process still running
  // when the wall falls scores nothing at all. Idle keep-alive sockets are
  // dropped at once; anything still open after a short grace is destroyed.
  await new Promise<void>((resolve) => {
    const grace = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, SHUTDOWN_GRACE_MS);
    server.close(() => {
      clearTimeout(grace);
      resolve();
    });
    server.closeIdleConnections();
  });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
