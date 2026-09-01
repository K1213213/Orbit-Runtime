import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ClockSource } from "@orbit/infra-common";
import { PaeRemoteError } from "../../types";
import {
  decodeJsonRpc,
  encodeJsonRpc,
  jsonRpcRemoteErrorOf,
  type JsonRpcResponse
} from "./protocol";

/**
 * MCP transports (W16).
 *
 * The transport is an injected dependency rather than something the adapter
 * constructs inline, for the same reason seams exist anywhere else: an adapter
 * that can only talk to a real subprocess can only be tested by running a real
 * subprocess, which makes the deterministic-replay suite slow, flaky and
 * platform-dependent. With `IMcpTransport` in place, the adapter's protocol
 * behaviour is tested against `InMemoryMcpTransport` and the subprocess wiring
 * is a thin, separately-reviewable shell.
 */

/** How much of a failing peer's stderr to keep for diagnostics. */
const STDERR_TAIL_LIMIT = 2048;

export interface IMcpTransport {
  /** Send a request and wait for the correlated response. */
  request(method: string, params: unknown, timeoutMs: number): Promise<JsonRpcResponse>;
  /** Fire-and-forget message; resolves once written. */
  notify(method: string, params?: unknown): Promise<void>;
  /** Release the underlying resource. Idempotent. */
  close(): Promise<void>;
  readonly closed: boolean;
}

/**
 * Wall-clock source used only for deadlines.
 *
 * This is deliberately NOT the kernel's injected `ClockSource` in the
 * determinism sense: nothing computed here reaches a recorded value. It exists
 * so that tests can advance time without waiting, and so that production can
 * use the real clock without the adapter hard-coding `Date.now()`.
 */
function defaultClock(): ClockSource {
  return { now: () => Date.now() };
}

/* ------------------------------------------------------------------ */
/* In-memory                                                           */
/* ------------------------------------------------------------------ */

/**
 * Handles MCP methods directly in-process. This is what tests use: it exercises
 * the adapter's real request/response, discovery and error paths without a
 * subprocess.
 */
export type McpRequestHandler = (method: string, params: unknown) => unknown | Promise<unknown>;

export class InMemoryMcpTransport implements IMcpTransport {
  private _closed = false;
  private nextId = 1;
  private readonly clock: ClockSource;

  public constructor(
    private readonly handler: McpRequestHandler,
    options: { clock?: ClockSource } = {}
  ) {
    this.clock = options.clock ?? defaultClock();
  }

  public get closed(): boolean {
    return this._closed;
  }

  public async request(method: string, params: unknown, timeoutMs: number): Promise<JsonRpcResponse> {
    if (this._closed) {
      throw new PaeRemoteError(`mcp transport is closed (request ${method})`);
    }
    const id = this.nextId++;
    const started = this.clock.now();
    try {
      const result = await this.handler(method, params ?? {});
      if (this.clock.now() - started > timeoutMs) {
        throw new PaeRemoteError(`mcp request ${method} exceeded ${timeoutMs}ms`);
      }
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      if (err instanceof PaeRemoteError) throw err;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) }
      };
    }
  }

  public async notify(method: string, params: unknown = {}): Promise<void> {
    if (this._closed) {
      throw new PaeRemoteError(`mcp transport is closed (notify ${method})`);
    }
    await this.handler(method, params);
  }

  public async close(): Promise<void> {
    this._closed = true;
  }
}

/* ------------------------------------------------------------------ */
/* stdio subprocess                                                    */
/* ------------------------------------------------------------------ */

export interface StdioMcpTransportConfig {
  /** Executable to spawn (e.g. `npx`, `node`, `python`). */
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  /**
   * Run through the platform shell. Needed on Windows for `npx`-style commands
   * that are batch scripts rather than executables.
   */
  shell?: boolean;
  clock?: ClockSource;
}

/**
 * JSON-RPC over a child process's stdin/stdout, newline-delimited.
 *
 * Responsibilities are deliberately narrow: correlate responses by id, enforce
 * the caller's deadline, and make sure a dead peer fails every in-flight
 * request instead of hanging them. Protocol *semantics* live in the adapter.
 */
export class StdioMcpTransport implements IMcpTransport {
  private child: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private _closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly clock: ClockSource;
  private fatal: Error | null = null;
  /** Bounded tail of the peer's stderr, surfaced only when the peer fails. */
  private stderrTail = "";

  public constructor(private readonly config: StdioMcpTransportConfig) {
    this.clock = config.clock ?? defaultClock();
  }

  public get closed(): boolean {
    return this._closed;
  }

  /** Spawn the peer. Idempotent — a second call is a no-op. */
  public async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.config.command, this.config.args ?? [], {
      env: this.config.env ? ({ ...process.env, ...this.config.env } as NodeJS.ProcessEnv) : process.env,
      cwd: this.config.cwd,
      shell: this.config.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      /*
       * Stderr is a diagnostic channel, not a failure channel: a chatty server
       * must not be able to fail a call. But swallowing it entirely made a
       * server that died on startup report nothing but its exit code, which is
       * undiagnosable. Keep a bounded tail and surface it only when the peer
       * actually fails.
       */
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    /*
     * A dying peer can EPIPE an in-flight write; the stdin stream then emits an
     * 'error' event that becomes an uncaught exception without a listener. The
     * 'exit' handler already fails every in-flight request, so this listener
     * only keeps the failure inside the channel. stdout/stderr read-stream
     * errors are likewise swallowed — diagnostics go through the stderr tail.
     */
    child.stdin?.on("error", (err) => {
      if (!this.fatal) {
        this.failAll(new PaeRemoteError(`mcp server stdin error: ${err.message}`));
      }
    });
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.on("error", (err) =>
      this.failAll(new PaeRemoteError(`mcp spawn failed: ${err.message}${this.stderrContext()}`))
    );
    child.on("exit", (code) => {
      this.failAll(
        new PaeRemoteError(
          `mcp server exited${code === null ? "" : ` with code ${code}`}${this.stderrContext()}`
        )
      );
    });
  }

  /** The peer's last words, when it had any, formatted for an error message. */
  private stderrContext(): string {
    const tail = this.stderrTail.trim();
    if (tail === "") return "";
    return ` — peer stderr: ${tail.replace(/\s+/g, " ")}`;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.handleLine(line);
      nl = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    const response = decodeJsonRpc(line);
    if (!response) return;
    const key = typeof response.id === "number" ? response.id : Number(response.id);
    const entry = this.pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    entry.resolve(response);
  }

  private failAll(err: Error): void {
    this.fatal = err;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  public async request(method: string, params: unknown, timeoutMs: number): Promise<JsonRpcResponse> {
    if (this._closed) {
      throw new PaeRemoteError(`mcp transport is closed (request ${method})`);
    }
    if (this.fatal) throw this.fatal;
    if (!this.child) await this.start();

    const id = this.nextId++;
    const message = encodeJsonRpc({ jsonrpc: "2.0", id, method, params: params ?? {} });

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PaeRemoteError(`mcp request ${method} timed out after ${timeoutMs}ms`));
      }, Math.max(0, timeoutMs));

      this.pending.set(id, { resolve, reject, timer });
      const stdin = this.child?.stdin;
      if (!stdin) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new PaeRemoteError(`mcp server has no writable stdin (request ${method})`));
        return;
      }
      stdin.write(`${message}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          // A dying peer EPIPEs the in-flight write; fold its last words in.
          reject(new PaeRemoteError(`mcp write failed: ${err.message}${this.stderrContext()}`));
        }
      });
    });
  }

  public async notify(method: string, params: unknown = {}): Promise<void> {
    if (this._closed) {
      throw new PaeRemoteError(`mcp transport is closed (notify ${method})`);
    }
    if (this.fatal) throw this.fatal;
    if (!this.child) await this.start();
    const stdin = this.child?.stdin;
    if (!stdin) throw new PaeRemoteError(`mcp server has no writable stdin (notify ${method})`);
    const message = encodeJsonRpc({ jsonrpc: "2.0", method, params });
    await new Promise<void>((resolve, reject) => {
      stdin.write(`${message}\n`, (err) =>
        err ? reject(new PaeRemoteError(`mcp write failed: ${err.message}${this.stderrContext()}`)) : resolve()
      );
    });
  }

  public async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.failAll(new PaeRemoteError("mcp transport closed"));
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      /* Peer may already be gone; closing is best-effort. */
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

/**
 * Unwrap a response into its result, converting a peer-reported error into a
 * typed failure. Shared by the adapter so both transports behave identically.
 */
export function unwrapResponse(response: JsonRpcResponse, method: string): unknown {
  const err = jsonRpcRemoteErrorOf(response);
  if (err) {
    throw new PaeRemoteError(`mcp ${method} failed (${err.code}): ${err.message}`);
  }
  return response.result;
}
