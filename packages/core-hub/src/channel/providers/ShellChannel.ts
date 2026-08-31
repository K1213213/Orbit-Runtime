import { spawn } from "node:child_process";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { IChannelProvider } from "../IChannelProvider";
import type { ChannelCallCtx } from "@orbit/infra-common";
import type { ChannelRuntimeMeta } from "../../replay/determinism";
import { DeterminismLevel } from "@orbit/infra-common";
import { ChannelCallFaultError } from "@orbit/infra-common";

export interface ShellChannelConfig {
  /**
   * Command whitelist — exact string matches only. A command not in this list
   * is rejected before any process is spawned. Absolute paths may be listed
   * verbatim (e.g. process.execPath).
   */
  allowedCommands: string[];
  /** Working directory for spawned processes; created on setup. Default: cwd. */
  workDir?: string;
  /** Hard execution timeout in ms; the process is killed on expiry. Default 10_000. */
  timeoutMs?: number;
  /** Per-stream output cap in bytes; excess is truncated with a marker. Default 1 MiB. */
  maxOutputBytes?: number;
  /**
   * Environment variables passed through to the child. Default: none — the
   * child runs with an effectively empty environment (secrets never leak by
   * accident). List what the whitelisted commands actually need, e.g. ["PATH", "SystemRoot"].
   */
  envAllowlist?: string[];
}

/** Result of one command execution. A non-zero exit code is data, not a fault. */
export interface ShellExecResult {
  /** Captured stdout, UTF-8, truncated to maxOutputBytes. */
  stdout: string;
  /** Captured stderr, UTF-8, truncated to maxOutputBytes. */
  stderr: string;
  /** Process exit code; -1 when the process was killed or never exited normally. */
  exitCode: number;
  /** True when the process was killed by the channel timeout. */
  timedOut: boolean;
  /** True when stdout or stderr was truncated at the output cap. */
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const TRUNCATION_MARKER = "\n...[orbit: output truncated]";

/**
 * Real command-execution channel behind an explicit whitelist.
 *
 * Determinism contract: io-bound — execution touches external state, so replay
 * relies on output-snapshot injection via the record journal. The result
 * object is plain JSON so it snapshots and reconciles cleanly.
 *
 * Security posture:
 * - Commands are spawned with an argv array (never a shell string), so there
 *   is no shell-injection surface; arguments are passed verbatim.
 * - Only whitelisted commands may run; the whitelist match is exact.
 * - The child runs with an empty environment unless variables are allowlisted.
 * - A hard timeout kills runaway processes; output is capped per stream.
 *
 * Semantics note: a non-zero exit code is a *result* (the command ran and
 * reported failure), not a channel fault. Channel faults are whitelist
 * denials, spawn failures and timeouts.
 */
export class ShellChannel implements IChannelProvider {
  public readonly determinismMeta: ChannelRuntimeMeta = {
    determinism: DeterminismLevel.IO_BOUND,
    replayPolicy: "inject"
  };

  private readonly allowedCommands: ReadonlySet<string>;
  private readonly workDirAbs: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly envAllowlist: string[];

  public constructor(private readonly config: ShellChannelConfig) {
    if (!Array.isArray(config.allowedCommands)) {
      throw new Error("ShellChannel requires allowedCommands (an array of exact command names)");
    }
    this.allowedCommands = new Set(config.allowedCommands);
    this.workDirAbs = path.resolve(config.workDir ?? process.cwd());
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.envAllowlist = config.envAllowlist ?? [];
  }

  public async setup(_ctx: ChannelCallCtx): Promise<void> {
    await fs.mkdir(this.workDirAbs, { recursive: true });
  }

  public async teardown(): Promise<void> {}

  /**
   * Execute a whitelisted command with the given argv. `args` must be an
   * array of strings (or omitted); shell strings are not accepted.
   */
  public async execCommand(command: string, args: string[] = []): Promise<ShellExecResult> {
    if (typeof command !== "string" || command.length === 0) {
      throw new ChannelCallFaultError("shell channel command must be a non-empty string");
    }
    if (command.includes("\0")) {
      throw new ChannelCallFaultError("shell channel command contains a null byte");
    }
    if (!this.allowedCommands.has(command)) {
      throw new ChannelCallFaultError(
        `command is not whitelisted on the shell channel: ${command}`
      );
    }
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      throw new ChannelCallFaultError("shell channel args must be an array of strings");
    }

    return await this.runProcess(command, args);
  }

  /** Command names currently allowed (for introspection / console display). */
  public listAllowedCommands(): string[] {
    return [...this.allowedCommands].sort();
  }

  // ---------------------------------------------------------------- internals

  private runProcess(command: string, args: string[]): Promise<ShellExecResult> {
    return new Promise<ShellExecResult>((resolve, reject) => {
      let child;
      try {
        child = spawn(command, args, {
          cwd: this.workDirAbs,
          env: this.filteredEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });
      } catch (err) {
        reject(new ChannelCallFaultError(`failed to spawn command: ${command} (${this.errText(err)})`));
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        const capped = this.captureCapped(stdoutChunks, chunk);
        if (capped) truncated = true;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const capped = this.captureCapped(stderrChunks, chunk);
        if (capped) truncated = true;
      });

      child.on("error", (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        reject(new ChannelCallFaultError(`command execution failed: ${command} (${err.message})`));
      });

      child.on("close", (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve({
          stdout: this.decodeCapped(stdoutChunks),
          stderr: this.decodeCapped(stderrChunks),
          exitCode: typeof code === "number" ? code : -1,
          timedOut,
          truncated
        });
      });
    });
  }

  /** Append a chunk while respecting the output cap; returns true when capped. */
  private captureCapped(chunks: Buffer[], chunk: Buffer): boolean {
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    if (total >= this.maxOutputBytes) return true;
    const room = this.maxOutputBytes - total;
    if (chunk.length <= room) {
      chunks.push(chunk);
      return false;
    }
    chunks.push(chunk.subarray(0, room));
    return true;
  }

  private decodeCapped(chunks: Buffer[]): string {
    const joined = Buffer.concat(chunks);
    const text = joined.toString("utf8");
    if (joined.length >= this.maxOutputBytes) {
      return text + TRUNCATION_MARKER;
    }
    return text;
  }

  /** Only allowlisted variables pass through; everything else is dropped. */
  private filteredEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of this.envAllowlist) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return env;
  }

  private errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
