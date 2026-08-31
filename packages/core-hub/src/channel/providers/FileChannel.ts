import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { IChannelProvider } from "../IChannelProvider";
import type { ChannelCallCtx } from "@orbit/infra-common";
import type { ChannelRuntimeMeta } from "../../replay/determinism";
import { DeterminismLevel } from "@orbit/infra-common";
import { ChannelCallFaultError } from "@orbit/infra-common";

export interface FileChannelConfig {
  /**
   * Root directory all channel paths are jailed to. Relative paths resolve
   * against it; any resolved path escaping the root is rejected.
   */
  rootDir: string;
  /** Create the root directory on setup when missing; default true. */
  createRootDir?: boolean;
  /**
   * Read/write size guard in bytes; default 8 MiB. Protects the record
   * journal (output snapshots live in memory) from runaway files.
   */
  maxFileBytes?: number;
}

/** Result of statPath. `kind: "missing"` marks a path that does not exist. */
export interface FileStatInfo {
  exists: boolean;
  kind: "file" | "dir" | "other" | "missing";
  sizeBytes: number;
  modifiedAt: string | null;
}

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const UTF8 = "utf8";

/**
 * Real filesystem channel (text files) jailed to a configurable root.
 *
 * Determinism contract: io-bound — every method touches external state, so
 * replay relies on output-snapshot injection via the record journal (exactly
 * what the hub provides). Methods with side effects (write/append/remove/mkdir)
 * return small deterministic values so they reconcile cleanly.
 *
 * Security: all paths are resolved and verified to stay inside rootDir
 * (path-escape attempts throw); null bytes are rejected upfront.
 */
export class FileChannel implements IChannelProvider {
  public readonly determinismMeta: ChannelRuntimeMeta = {
    determinism: DeterminismLevel.IO_BOUND,
    replayPolicy: "inject"
  };

  private readonly rootAbs: string;
  private readonly maxFileBytes: number;

  public constructor(private readonly config: FileChannelConfig) {
    if (typeof config.rootDir !== "string" || config.rootDir.trim() === "") {
      throw new Error("FileChannel requires a rootDir");
    }
    this.rootAbs = path.resolve(config.rootDir);
    this.maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  public async setup(_ctx: ChannelCallCtx): Promise<void> {
    if (this.config.createRootDir ?? true) {
      await fs.mkdir(this.rootAbs, { recursive: true });
      return;
    }
    const stat = await fs.stat(this.rootAbs).catch(() => null);
    if (stat === null || !stat.isDirectory()) {
      throw new Error(`FileChannel rootDir does not exist: ${this.rootAbs}`);
    }
  }

  public async teardown(): Promise<void> {}

  // ------------------------------------------------------------------- read

  /** Read a UTF-8 text file; returns null when the file does not exist. */
  public async readTextFile(relPath: string): Promise<string | null> {
    const abs = this.resolveInRoot(relPath);
    let content: string;
    try {
      const handle = await fs.open(abs, "r");
      try {
        const size = (await handle.stat()).size;
        if (size > this.maxFileBytes) {
          throw new ChannelCallFaultError(
            `file ${relPath} is ${size} bytes, exceeding the ${this.maxFileBytes} byte limit`
          );
        }
        content = await handle.readFile(UTF8);
      } finally {
        await handle.close();
      }
    } catch (err) {
      if (this.isNotFound(err)) return null;
      throw err;
    }
    if (Buffer.byteLength(content, UTF8) > this.maxFileBytes) {
      throw new ChannelCallFaultError(`file ${relPath} exceeds the ${this.maxFileBytes} byte limit`);
    }
    return content;
  }

  /** List a directory's entry names, sorted alphabetically (deterministic order). */
  public async listDir(relPath: string): Promise<string[]> {
    const abs = this.resolveInRoot(relPath);
    try {
      const names = await fs.readdir(abs);
      return [...names].sort();
    } catch (err) {
      if (this.isNotFound(err)) {
        throw new ChannelCallFaultError(`directory does not exist: ${relPath}`);
      }
      throw err;
    }
  }

  /** Stat a path; never throws for missing paths (returns kind "missing"). */
  public async statPath(relPath: string): Promise<FileStatInfo> {
    const abs = this.resolveInRoot(relPath);
    const stat = await fs.stat(abs).catch(() => null);
    if (stat === null) {
      return { exists: false, kind: "missing", sizeBytes: 0, modifiedAt: null };
    }
    return {
      exists: true,
      kind: stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other",
      sizeBytes: stat.isDirectory() ? 0 : stat.size,
      modifiedAt: stat.mtime !== undefined ? stat.mtime.toISOString() : null
    };
  }

  // ------------------------------------------------------------------ write

  /** Write a UTF-8 text file (parent directories are created); returns bytes written. */
  public async writeTextFile(relPath: string, content: string): Promise<number> {
    const abs = this.resolveInRoot(relPath);
    const bytes = Buffer.byteLength(content, UTF8);
    if (bytes > this.maxFileBytes) {
      throw new ChannelCallFaultError(`write of ${relPath} (${bytes} bytes) exceeds the ${this.maxFileBytes} byte limit`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, UTF8);
    return bytes;
  }

  /** Append to a UTF-8 text file (created when missing); returns bytes appended. */
  public async appendTextFile(relPath: string, content: string): Promise<number> {
    const abs = this.resolveInRoot(relPath);
    const bytes = Buffer.byteLength(content, UTF8);
    const current = await fs.stat(abs).catch(() => null);
    const currentSize = current?.isFile() ? current.size : 0;
    if (currentSize + bytes > this.maxFileBytes) {
      throw new ChannelCallFaultError(`append to ${relPath} would exceed the ${this.maxFileBytes} byte limit`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.appendFile(abs, content, UTF8);
    return bytes;
  }

  /** Create a directory (recursive); resolves once the directory exists. */
  public async makeDir(relPath: string): Promise<void> {
    const abs = this.resolveInRoot(relPath);
    await fs.mkdir(abs, { recursive: true });
  }

  /**
   * Remove a file or empty directory. Non-empty directories require
   * `recursive: true` (safe-by-default: no accidental tree deletion).
   */
  public async removePath(relPath: string, recursive: boolean = false): Promise<void> {
    const abs = this.resolveInRoot(relPath);
    await fs.rm(abs, { recursive, force: false });
  }

  // --------------------------------------------------------------- internals

  /**
   * Path jail: resolve inside the root and refuse escapes. Absolute paths are
   * legal only when they resolve back inside the root; `..` traversal beyond
   * the root is rejected, as are null bytes.
   */
  private resolveInRoot(relPath: string): string {
    if (typeof relPath !== "string" || relPath.length === 0) {
      throw new ChannelCallFaultError("file channel path must be a non-empty string");
    }
    if (relPath.includes("\0")) {
      throw new ChannelCallFaultError("file channel path contains a null byte");
    }
    // 拒绝 Windows 风格分隔符：Unix 上 `\` 不是分隔符，path.resolve 不会展开它，
    // 但同一代码在 Windows 部署时 `..\..` 可穿越 root；统一按非法路径输入拒绝。
    if (relPath.includes("\\")) {
      throw new ChannelCallFaultError(`path escapes the file channel root: ${relPath}`);
    }
    const abs = path.resolve(this.rootAbs, relPath);
    if (abs !== this.rootAbs && !abs.startsWith(this.rootAbs + path.sep)) {
      throw new ChannelCallFaultError(`path escapes the file channel root: ${relPath}`);
    }
    return abs;
  }

  private isNotFound(err: unknown): boolean {
    return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}
