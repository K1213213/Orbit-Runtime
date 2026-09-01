import { ChannelHub } from "../channel/ChannelHub";
import { RecordJournal, GatewayCallRecord } from "../replay/record_journal";
import { ReplayEngine, ReplayDriftError, ReconcileReport } from "../replay/replay_engine";
import { digestInputs } from "@orbit/infra-common";
import { TripProtector } from "../safeguard/TripProtector";
import { TripProtectionBlockError } from "@orbit/infra-common";
import { makeUniqueMark } from "@orbit/infra-common";
import { ChannelKind, ChannelCallCtx, ReplayMode, GatewayDecision, RunVersionFingerprint } from "@orbit/infra-common";
import type { ClockSource } from "@orbit/infra-common";
import { GatewayCheckers, RunFingerprintDriftError, DecisionDriftError } from "./types";
import { packSnapshot, isCompressedPayload, decompressPayload } from "../gateway/TokenBudgetEngine";
import { BehaviorCollector } from "./BehaviorCollector";
import type { BehaviorNote } from "@orbit/infra-common";

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
  /** Optional behavior collector (W11); null when the host doesn't wire one. */
  private collector: BehaviorCollector | null = null;
  /** The decision of the most recently served call (surfaced for audit). */
  public lastDecision: GatewayDecision | null = null;

  /**
   * @param clock Passed to the per-plugin {@link TripProtector}s created here.
   *   The trip decision is part of every recorded `GatewayDecision`, so the
   *   cooldown must not read the real wall clock. Optional: omitting it keeps
   *   the previous behaviour.
   */
  public constructor(
    private readonly hub: ChannelHub,
    private readonly checkers: GatewayCheckers,
    private readonly clock?: ClockSource
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

  /** Attach a behavior collector (W11). Optional — replay bypasses it. */
  public attachCollector(collector: BehaviorCollector): void {
    this.collector = collector;
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
    // still blocks. This is DECISION drift (the recorded pactPass no longer
    // holds), reported distinctly from config drift and call drift.
    if (pluginId && !this.checkers.pactPass(pluginId, kind, funcName)) {
      throw new DecisionDriftError(
        "pactPass",
        `replay blocked: plugin ${pluginId} lacks capability for ${kind}.${funcName}`,
        ctx?.traceMarkId
      );
    }
    this.replaySeq += 1;
    this.lastDecision = record.decision ?? null;
    // W9: a compressed-at-rest snapshot is transparently decompressed so the
    // consumer receives the identical original value it saw on the live path.
    const raw = record.outputSnapshot;
    const served = isCompressedPayload(raw) ? decompressPayload(raw) : raw;
    return structuredClone(served) as T;
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

    // Now that the output exists, compute the payload-aware compression
    // decision and assemble the full governance decision snapshot.
    const comp = this.checkers.compression(output);
    const decision: GatewayDecision = {
      tripAllowed,
      pactPass: pluginId ? this.checkers.pactPass(pluginId, kind, funcName) : true,
      budget: this.checkers.budgetDecision(pluginId ?? ""),
      compression: { level: comp.level, applied: comp.applied },
      route: this.checkers.route(pluginId ?? "", kind),
      rateLimited: pluginId ? this.checkers.rateLimited(pluginId) : false
    };

    // W11: advance the rate limiter AFTER the decision is captured, so the
    // recorded `rateLimited` reflects the state BEFORE this call. Replay never
    // reaches here — the frozen decision is restored verbatim.
    if (pluginId) this.checkers.consumeRateLimit?.(pluginId);

    // W8: feed the output back to the budget engine (LLM strings) so cumulative
    // token usage drives the NEXT call's budget decision. Deterministic and
    // executed only on the live path — replay never reaches here.
    if (pluginId) this.checkers.accountTokens?.(pluginId, output);

    // W9: compress the stored snapshot at rest when the policy says so. The
    // consumer still receives the ORIGINAL `output` (returned below) — this is
    // a storage optimization, never a semantic trim, so live and replay remain
    // byte-identical (axioms A1/A2 hold).
    const packed = comp.applied ? packSnapshot(output, comp.level) : { served: output, applied: false, bytesSaved: 0 };
    decision.compression.applied = packed.applied;
    decision.compression.bytesSaved = packed.bytesSaved;

    // W11: build the structured behavior observation for this call.
    const note: BehaviorNote = {
      channelKind: kind,
      funcName,
      pluginId,
      route: decision.route,
      compression: {
        level: decision.compression.level,
        applied: decision.compression.applied,
        bytesSaved: decision.compression.bytesSaved ?? 0
      },
      budget: { allow: decision.budget.allow, strategy: decision.budget.strategy },
      rateLimited: decision.rateLimited,
      tokensEstimated: this.checkers.estimateTokens ? this.checkers.estimateTokens(output) : undefined,
      recordedAtMode: this.journal ? "record" : "live"
    };

    const runFingerprint = this.checkers.fingerprint();
    const record = this.journal?.append({
      channelKind: kind,
      funcName,
      inputDigest,
      outputSnapshot: packed.served,
      durationMs: 0,
      decision,
      runFingerprint
    });
    // W11: attach the behavior note in "record" mode (persisted with the
    // trace); in "live" mode it is a proposal only (not persisted). Replay
    // never reaches here, so the collector is bypassed and the stored note is
    // restored from the journal instead.
    if (this.collector && record) {
      this.collector.collect(this.journal ? "record" : "live", note, record);
    }
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
      t = new TripProtector(undefined, undefined, this.clock);
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
    // W15: the adaptation surface is part of the configuration. Absent on both
    // sides means "recorded before the field existed" — treated as compatible;
    // a value on one side only is a genuine surface change.
    const recordedPae = fp.paeAdaptersHash ?? "";
    const currentPae = cur.paeAdaptersHash ?? "";
    if (recordedPae !== currentPae) {
      throw new RunFingerprintDriftError(
        "paeAdaptersHash",
        `pae adapter surface drift: recorded ${recordedPae || "<none>"} vs current ${currentPae || "<none>"}`,
        traceMarkId
      );
    }
    // W29: the governance tier is part of the configuration. Absent on both
    // sides means "both are the default tier" — compatible; a value on one
    // side only (or differing values) is a genuine tier change.
    const recordedGov = fp.governanceProfileHash ?? "";
    const currentGov = cur.governanceProfileHash ?? "";
    if (recordedGov !== currentGov) {
      throw new RunFingerprintDriftError(
        "governanceProfileHash",
        `governance tier drift: recorded ${recordedGov || "standard"} vs current ${currentGov || "standard"}`,
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
