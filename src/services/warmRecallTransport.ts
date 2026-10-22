import { connect } from "node:net";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

// Transport only: the calling hook still resolves config, scopes and search anew.
const ACK_MS = 200;
const DEFAULT_BUDGET_MS = 3000; // the hosted search deadline; recall.ts passes the real one
const BACKOFF_MS = 60_000;
const MAX_FRAME = 12 * 1024 * 1024;
const READ_PATH = /^\/(?:v5\/)?ns\/[^/]+\/(?:search|list\/(?:memories|documents))\/?$/;
/** One line of evidence per fetch: did the helper serve it, and if not why. Never carries request content. */
export interface WarmReport { used: boolean; reason: string; ms: number }
interface WarmOptions {
  socketPath?: string; autoStart?: boolean; direct?: typeof fetch; budgetMs?: number;
  onResult?: (report: WarmReport) => void;
}

// The helper answered in time but the budget or provider failed. That says nothing bad about the helper.
class ProviderSide extends Error {}

// The helper accepted the connection but went silent: the only failure that says "do not wait for this helper".
class Stalled extends Error {
  constructor(readonly kind: "ack-timeout" | "heartbeat-timeout") { super(kind); }
}

// Marker files next to the socket (private 0700 directory), shared by every hook process:
//   last-spawn: a helper start was attempted, whether or not it worked
//   stalled:    a helper accepted a connection but did not answer (e.g. SIGSTOP while holding the lock)
function markerTime(socket: string, name: "last-spawn" | "stalled"): number | undefined {
  try {
    const st = lstatSync(join(dirname(socket), name));
    return st.isFile() && st.uid === process.getuid?.() ? st.mtimeMs : undefined;
  } catch { return undefined; }
}

function recent(socket: string, name: "last-spawn" | "stalled"): boolean {
  const at = markerTime(socket, name);
  return at !== undefined && Date.now() - at < BACKOFF_MS;
}

// A helper started after the stall is a different helper: that stall no longer says anything about it.
function isStalled(socket: string): boolean {
  const at = markerTime(socket, "stalled"), spawned = markerTime(socket, "last-spawn");
  return recent(socket, "stalled") && !(at !== undefined && spawned !== undefined && spawned > at);
}

function touch(socket: string, name: "last-spawn" | "stalled"): void {
  try { writeFileSync(join(dirname(socket), name), String(Date.now()), { mode: 0o600 }); } catch { /* optional */ }
}

function privateDirectory(path: string): boolean {
  const st = lstatSync(path);
  return st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid?.()
    && (st.mode & 0o077) === 0 && realpathSync(path) === path;
}

function endpoint(): string | undefined {
  if (process.platform !== "linux" || process.env.SUPERMEMORY_RECALL_WARM === "0") return;
  try {
    const base = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`;
    if (!privateDirectory(base)) return;
    const id = createHash("sha256").update(__dirname).digest("hex").slice(0, 12);
    const dir = join(base, `smr-${id}`);
    mkdirSync(dir, { mode: 0o700, recursive: true });
    const path = join(dir, "r.sock");
    return privateDirectory(dir) && Buffer.byteLength(path) < 104 ? path : undefined;
  } catch { return; }
}

function safeEndpoint(path: string): boolean {
  try {
    const st = lstatSync(path);
    return privateDirectory(dirname(path)) && st.isSocket() && st.uid === process.getuid?.()
      && (st.mode & 0o077) === 0;
  } catch { return false; }
}

function exchange(path: string, request: Request, body: string, deadlineAt: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = Buffer.alloc(0), ready = false, done = false;
    const finish = (error?: Error, response?: Response) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(deadline); request.signal.removeEventListener("abort", abort);
      socket.destroy(); error ? reject(error) : resolve(response!);
    };
    const abort = () => finish(new Error("warm transport aborted"));
    let timer = setTimeout(() => finish(new Stalled("ack-timeout")), ACK_MS);
    // Whole-request deadline: heartbeats prove the helper is alive, they do not extend the caller's budget.
    const deadline = setTimeout(() => finish(new ProviderSide("warm deadline")), Math.max(0, deadlineAt - performance.now()));
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Stalled("heartbeat-timeout")), ACK_MS);
    };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) { abort(); return; }
    socket.on("error", error => finish(error));
    socket.on("end", () => finish(new Error("warm helper incomplete response")));
    socket.on("connect", () => socket.write(JSON.stringify({
      v: 1, url: request.url, method: request.method,
      headers: Object.fromEntries(request.headers), body,
      budget_ms: Math.max(1, Math.floor(deadlineAt - performance.now())),
    }) + "\n"));
    socket.on("data", data => {
      if (done) return;
      if (buffer.length + data.length > MAX_FRAME) { finish(new Error("warm response too large")); return; }
      buffer = Buffer.concat([buffer, data]);
      for (let end; !done && (end = buffer.indexOf(10)) >= 0;) {
        const line = buffer.subarray(0, end).toString("utf8"); buffer = buffer.subarray(end + 1);
        try {
          const value = JSON.parse(line);
          if (value?.v !== 1) throw Error("warm protocol mismatch");
          if (value.error === true) throw new ProviderSide("warm helper gave up");
          if (!ready) {
            if (value.ready !== true) throw Error("warm helper not ready");
            ready = true; alive();
            // ACK is local readiness, not a 200ms deadline for the provider search.
          } else if (value.busy === true) {
            alive(); // Local liveness only: the caller's provider deadline is unchanged.
          } else {
            if (!Number.isInteger(value.status) || value.status < 200 || value.status > 599
              || typeof value.body !== "string" || !value.headers || Array.isArray(value.headers)
              || typeof value.headers !== "object"
              || Object.values(value.headers).some(v => typeof v !== "string")) throw Error("warm malformed response");
            // Never turn a broken JSON frame into a successful empty search.
            if (value.status >= 200 && value.status < 300) JSON.parse(value.body);
            finish(undefined, new Response(value.body, { status: value.status, headers: value.headers }));
          }
        } catch (error) { finish(error instanceof ProviderSide ? error : new Error("warm malformed response")); }
      }
    });
  });
}

export function createWarmFetch(options: WarmOptions = {}): typeof fetch {
  const direct = options.direct ?? fetch;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  let started = false;
  const start = (path: string) => {
    if (started || options.autoStart === false || recent(path, "last-spawn")) return;
    started = true;
    touch(path, "last-spawn"); // before spawning: a start that fails must not repeat on the next prompt
    try {
      const child = spawn("/usr/bin/python3", ["-I", join(__dirname, "recall-warm.py"), "--socket", path], {
        detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      });
      child.on("error", () => {}); child.unref();
    } catch { /* This prompt is already using the original transport. */ }
  };
  return async (input, init) => {
    const begin = performance.now();
    const report = (used: boolean, reason: string) => {
      try { options.onResult?.({ used, reason, ms: Math.round(performance.now() - begin) }); } catch { /* evidence only */ }
    };
    const fallback = (reason: string) => { report(false, reason); return direct(input, init); };
    const path = options.socketPath ?? endpoint();
    if (!path) return fallback(process.env.SUPERMEMORY_RECALL_WARM === "0" ? "disabled-by-env" : "unsupported");
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.supermemory.ai" || !READ_PATH.test(url.pathname)
      || url.search || url.hash || request.method !== "POST") return fallback("not-eligible");
    if (!safeEndpoint(path)) { start(path); return fallback("no-helper"); }
    if (isStalled(path)) return fallback("stalled-backoff");
    try {
      const body = await request.clone().text();
      if (Buffer.byteLength(body) > 1024 * 1024) return fallback("oversize");
      const response = await exchange(path, request, body, begin + budgetMs);
      report(true, "helper");
      return response;
    } catch (error) {
      if (request.signal.aborted) { report(false, "aborted"); throw request.signal.reason; }
      // Only local transport failures fall back. HTTP 402/429 go to the original cooldown logic.
      const code = (error as NodeJS.ErrnoException).code;
      if (error instanceof Stalled) { touch(path, "stalled"); return fallback(error.kind); }
      if (error instanceof ProviderSide) return fallback("deadline-or-helper-error");
      // Any other local error (closed socket, full slots, idle-exit race) costs this one prompt only.
      if (code === "ECONNREFUSED" || code === "ENOENT") { start(path); return fallback("no-listener"); }
      return fallback("local-error");
    }
  };
}
