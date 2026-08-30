/**
 * Isolation domain transports (W19).
 *
 * The transport is an injected dependency, for the same reason every other
 * cross-process seam in this kernel is one: an L2 domain that can only talk to
 * a real child process can only be tested by running one. `InMemoryDomainTransport`
 * exercises the adapter behaviour without a process; `ChildProcessDomainTransport`
 * is the real L2 path (spawn `node`, newline-delimited JSON, correlated
 * responses, caller deadlines, in-flight requests failed when the host dies,
 * bounded stderr tail surfaced on failure).
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ClockSource } from "../../types/orbitDomain";
import { DomainRemoteError } from "./errors";
import { decodeDomainFrame, encodeDomainFrame, type DomainResponse } from "./protocol";

/** How much of a failing host's stderr to keep for diagnostics. */
const STDERR_TAIL_LIMIT = 2048;

export interface IDomainTransport {
  /** Send a request and wait for the correlated response. */
  request(method: string, params: unknown, timeoutMs: number): Promise<DomainResponse>;
  /** Release the underlying resource. Idempotent. */
  close(): Promise<void>;
  readonly closed: boolean;
}

/** Wall-clock source used only for deadlines; never reaches a recorded value. */
function defaultClock(): ClockSource {
  return { now: () => Date.now() };
}

/* ------------------------------------------------------------------ */
/* In-memory                                                           */
/* ------------------------------------------------------------------ */

/** Handles domain host methods directly in-process. What tests use. */
export type DomainRequestHandler = (method: string, params: unknown) => unknown | Promise<unknown>;

export class InMemoryDomainTransport implements IDomainTransport {
  private _closed = false;
  private nextId = 1;
  private readonly clock: ClockSource;

  public constructor(
    private readonly handler: DomainRequestHandler,
    options: { clock?: ClockSource } = {}
  ) {
    this.clock = options.clock ?? defaultClock();
  }

  public get closed(): boolean {
    return this._closed;
  }

  public async request(method: string, params: unknown, timeoutMs: number): Promise<DomainResponse> {
    if (this._closed) {
      throw new DomainRemoteError(`domain transport is closed (request ${method})`);
    }
    const id = this.nextId++;
    const started = this.clock.now();
    const result = await this.handler(method, params);
    if (this.clock.now() - started > timeoutMs) {
      throw new DomainRemoteError(`domain request ${method} timed out after ${timeoutMs}ms`);
    }
    return { jsonrpc: "2.0", id, result };
  }

  public async close(): Promise<void> {
    this._closed = true;
  }
}

/* ------------------------------------------------------------------ */
/* child-process                                                       */
/* ------------------------------------------------------------------ */

export interface ChildProcessDomainTransportConfig {
  /** Executable to spawn (normally `process.execPath` for a Node host). */
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Run through the platform shell (Windows batch-script hosts). */
  shell?: boolean;
  clock?: ClockSource;
}

/**
 * Bridge protocol over a child process's stdin/stdout, newline-delimited JSON.
 * Responsibilities are deliberately narrow, mirroring the Cordis stdio
 * transport: correlate responses by id, enforce the caller's deadline, and make
 * sure a dead host fails every in-flight request instead of hanging them.
 */
export class ChildProcessDomainTransport implements IDomainTransport {
  private child: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private _closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (r: DomainResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly clock: ClockSource;
  private fatal: Error | null = null;
  private stderrTail = "";

  public constructor(private readonly config: ChildProcessDomainTransportConfig) {
    this.clock = config.clock ?? defaultClock();
  }

  public get closed(): boolean {
    return this._closed;
  }

  /** Spawn the host. Idempotent — a second call is a no-op. */
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
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    /*
     * A dying host can EPIPE an in-flight write; the stdin stream then emits an
     * 'error' event that becomes an uncaught exception without a listener. The
     * 'exit' handler already fails every in-flight request, so this listener
     * only keeps the failure inside the channel. stdout/stderr read-stream
     * errors are likewise swallowed — diagnostics go through the stderr tail.
     */
    child.stdin?.on("error", (err) => {
      if (!this.fatal) {
        this.failAll(new DomainRemoteError(`domain host stdin error: ${err.message}`));
      }
    });
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.on("error", (err) =>
      this.failAll(new DomainRemoteError(`domain host spawn failed: ${err.message}${this.stderrContext()}`))
    );
    child.on("exit", (code) => {
      this.failAll(
        new DomainRemoteError(
          `domain host exited${code === null ? "" : ` with code ${code}`}${this.stderrContext()}`
        )
      );
    });
  }

  private stderrContext(): string {
    const tail = this.stderrTail.trim();
    if (tail === "") return "";
    return ` — host stderr: ${tail.replace(/\s+/g, " ")}`;
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
    const response = decodeDomainFrame(line);
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

  public async request(method: string, params: unknown, timeoutMs: number): Promise<DomainResponse> {
    if (this._closed) {
      throw new DomainRemoteError(`domain transport is closed (request ${method})`);
    }
    if (this.fatal) throw this.fatal;
    if (!this.child) await this.start();

    const id = this.nextId++;
    const message = encodeDomainFrame({ jsonrpc: "2.0", id, method, params: params ?? {} });

    return new Promise<DomainResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DomainRemoteError(`domain request ${method} timed out after ${timeoutMs}ms`));
      }, Math.max(0, timeoutMs));

      this.pending.set(id, { resolve, reject, timer });
      const stdin = this.child?.stdin;
      if (!stdin) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new DomainRemoteError(`domain host has no writable stdin (request ${method})`));
        return;
      }
      stdin.write(`${message}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new DomainRemoteError(`domain request ${method} failed to write: ${err.message}`));
        }
      });
    });
  }

  public async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.failAll(new DomainRemoteError("domain transport closed"));
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && !child.killed) {
      child.kill();
    }
  }
}

/** Raise a protocol-level failure, or return the result payload. */
export function unwrapDomainResponse(response: DomainResponse, method: string): unknown {
  const err = response.error;
  if (err) {
    throw new DomainRemoteError(`domain ${method} failed: ${err.message}`);
  }
  return response.result;
}
