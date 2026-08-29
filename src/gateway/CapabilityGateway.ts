import { ChannelHub } from "../channel/ChannelHub";
import { RecordJournal, GatewayCallRecord } from "../replay/record_journal";
import { ReplayEngine, ReplayDriftError, ReconcileReport } from "../replay/replay_engine";
import { digestInputs } from "../utils/digest";
import { TripProtector } from "../safeguard/TripProtector";
import { TripProtectionBlockError } from "../core/orbitDomainError";
import { makeUniqueMark } from "../utils/versionIdGen";
import { ChannelKind, ChannelCallCtx, ReplayMode, GatewayDecision, RunVersionFingerprint } from "../types/orbitDomain";
import { GatewayCheckers, RunFingerprintDriftError } from "./types";

export interface GatewayInvokeParams {
  kind: ChannelKind;
  /** Originating plugin; drives the capability gate and per-plugin trip state. */
  pluginId?: string;
  funcName: string;
  args: unknown[];
  /** "replay" injects frozen outputs; anything else executes and records. */
  mode: ReplayMode;
  /** Optional extra context (rng/clock/traceMarkId/maxWaitMs) for the call. */
  ctx?: Partial<ChannelCallCtx>;
}

/**
 * Unified gateway entry — the determinism boundary (UPGRADE_PLAN §A.4).
 *
 * Every non-deterministic governance decision (trip / pact / budget / rate
 * limit / route / compression) is computed HERE at record time and stored as a
 * `GatewayDecision` inside the `GatewayCallRecord`. On replay the decision is
 * RESTORED from the journal and the frozen output injected — the call never
 * re-executes, never re-checks live state. Configuration drift (a replayed
 * trace recorded under a different kernel/pact/token config) is reported as a
 * distinct `RunFingerprintDriftError`, not a generic digest mismatch.
 *
 * Layered on top of `ChannelHub.fireChannelCall`: it does not replace the
 * channel mechanism, it adds the validation + decision-recording layer.
 */
export class CapabilityGateway {
  private journal: RecordJournal | null = null;
  private replayEngine: ReplayEngine | null = null;
  /** Replay cursor; mirrors the journal order so call #N maps to record #N. */
  private replaySeq = 0;
  private readonly tripMap = new Map<string, TripProtector>();
  /** The decision of the most recently served call (surfaced for audit). */
  public lastDecision: GatewayDecision | null = null;

  public constructor(
    private readonly hub: ChannelHub,
    private readonly checkers: GatewayCheckers
  ) {}

  /** Attach the journal that record-mode calls are appended to. */
  public attachJournal(journal: RecordJournal): void {
    this.journal = journal;
    this.replayEngine = new ReplayEngine(journal);
  }

  /** Attach a replay engine; resets the replay cursor for a fresh session. */
  public attachReplayEngine(engine: ReplayEngine): void {
    this.replayEngine = engine;
    this.replaySeq = 0;
  }

  /** Convenience: open a recording window owned by this gateway. */
  public beginRecording(): RecordJournal {
    const journal = new RecordJournal();
    this.attachJournal(journal);
    return journal;
  }

  /** Read-only trip pre-check for a plugin (used by the host's checker). */
  public tripPreCheck(pluginId: string): boolean {
    const t = this.tripMap.get(pluginId);
    return t ? t.preCallCheck() : true;
  }

  public async capabilityInvoke<T>(params: GatewayInvokeParams): Promise<T> {
    const { kind, pluginId, funcName, args, mode, ctx } = params;
    const inputDigest = digestInputs(...args);
    if (mode === "replay") {
      return this.replay<T>(kind, pluginId, funcName, args, inputDigest, ctx);
    }
    return this.execute<T>(kind, pluginId, funcName, args, inputDigest, ctx);
  }

  // --- replay ---------------------------------------------------------

  private async replay<T>(
    kind: ChannelKind,
    pluginId: string | undefined,
    funcName: string,
    args: unknown[],
    inputDigest: string,
    ctx?: Partial<ChannelCallCtx>
  ): Promise<T> {
    if (!this.journal) {
      throw new ReplayDriftError("gateway has no journal attached for replay", ctx?.traceMarkId);
    }
    const record = this.journal.get(this.replaySeq);
    if (!record) {
      throw new ReplayDriftError(`call #${this.replaySeq} missing in journal`, ctx?.traceMarkId);
    }
    if (record.channelKind !== kind || record.funcName !== funcName || record.inputDigest !== inputDigest) {
      throw new ReplayDriftError(
        `call #${this.replaySeq} signature mismatch: ${kind}.${funcName}`,
        ctx?.traceMarkId
      );
    }
    // Config drift check BEFORE injecting — a different kernel/pact/token
    // config must surface as RunFingerprintDriftError, not digest drift.
    this.verifyFingerprint(record.runFingerprint, ctx?.traceMarkId);
    // Governance not weakened on replay: a capability revoked since recording
    // still blocks. trip state is runtime and is restored, not re-checked.
    if (pluginId && !this.checkers.pactPass(pluginId, kind, funcName)) {
      throw new ReplayDriftError(
        `replay blocked: plugin ${pluginId} lacks capability for ${kind}.${funcName}`,
        ctx?.traceMarkId
      );
    }
    this.replaySeq += 1;
    this.lastDecision = record.decision ?? null;
    return structuredClone(record.outputSnapshot) as T;
  }

  // --- record / live --------------------------------------------------

  private async execute<T>(
    kind: ChannelKind,
    pluginId: string | undefined,
    funcName: string,
    args: unknown[],
    inputDigest: string,
    ctx?: Partial<ChannelCallCtx>
  ): Promise<T> {
    const trip = this.tripFor(pluginId);
    const tripAllowed = trip ? trip.preCallCheck() : true;
    if (trip && !tripAllowed) {
      throw new TripProtectionBlockError("trip protector active, execution blocked (gateway)", ctx?.traceMarkId, pluginId);
    }

    const decision: GatewayDecision = {
      tripAllowed,
      pactPass: pluginId ? this.checkers.pactPass(pluginId, kind, funcName) : true,
      budget: this.checkers.budgetDecision(pluginId ?? ""),
      compression: this.checkers.compression(),
      route: this.checkers.route(pluginId ?? ""),
      rateLimited: pluginId ? this.checkers.rateLimited(pluginId) : false
    };

    const baseCtx: ChannelCallCtx = {
      traceMarkId: ctx?.traceMarkId ?? `gw-${makeUniqueMark()}`,
      pluginUnitId: pluginId,
      maxWaitMs: ctx?.maxWaitMs ?? 10_000,
      // "live" so the channel layer executes but does NOT self-record; the
      // gateway owns the (richer) GatewayCallRecord instead.
      replayMode: "live",
      rng: ctx?.rng,
      clock: ctx?.clock
    };

    const run = () => this.hub.fireChannelCall<T>(kind, baseCtx, funcName, ...args);
    const output = trip ? await trip.execWithProtect(run) : await run();

    const runFingerprint = this.checkers.fingerprint();
    this.journal?.append({
      channelKind: kind,
      funcName,
      inputDigest,
      outputSnapshot: output,
      durationMs: 0,
      decision,
      runFingerprint
    });
    this.lastDecision = decision;
    return output;
  }

  /** Compare two recorded chains; locates the first drift (digest or decision). */
  public reconcile(original: GatewayCallRecord[], replayed: GatewayCallRecord[]): ReconcileReport {
    if (!this.replayEngine) {
      throw new Error("gateway has no replay engine attached for reconcile");
    }
    return this.replayEngine.reconcile(original, replayed);
  }

  // --- internals ------------------------------------------------------

  private tripFor(pluginId: string | undefined): TripProtector | null {
    if (!pluginId) return null;
    let t = this.tripMap.get(pluginId);
    if (!t) {
      t = new TripProtector();
      this.tripMap.set(pluginId, t);
    }
    return t;
  }

  private verifyFingerprint(fp: RunVersionFingerprint | undefined, traceMarkId?: string): void {
    if (!fp) return; // legacy trace recorded before fingerprints existed
    const cur = this.checkers.fingerprint();
    if (fp.kernelVersion !== cur.kernelVersion) {
      throw new RunFingerprintDriftError(
        "kernelVersion",
        `kernel version drift: recorded ${fp.kernelVersion} vs current ${cur.kernelVersion}`,
        traceMarkId
      );
    }
    if (fp.paeEnabled !== cur.paeEnabled) {
      throw new RunFingerprintDriftError(
        "paeEnabled",
        `pae enabled drift: recorded ${fp.paeEnabled} vs current ${cur.paeEnabled}`,
        traceMarkId
      );
    }
    if (fp.tokenConfigHash !== cur.tokenConfigHash) {
      throw new RunFingerprintDriftError(
        "tokenConfigHash",
        `token config drift: recorded ${fp.tokenConfigHash} vs current ${cur.tokenConfigHash}`,
        traceMarkId
      );
    }
    const a = JSON.stringify(Object.entries(fp.pactVersions).sort());
    const b = JSON.stringify(Object.entries(cur.pactVersions).sort());
    if (a !== b) {
      throw new RunFingerprintDriftError(
        "pactVersions",
        `pact version drift: recorded ${a} vs current ${b}`,
        traceMarkId
      );
    }
  }
}
