import type { BehaviorNote } from "@orbit/infra-common";
import type { GatewayCallRecord } from "../replay/record_journal";

/**
 * Behavior collector (W11) — captures a structured `BehaviorNote` for each
 * governed call. Three modes (note: these are the collector's record/live/replay
 * trinity, not the governance profiles of VISION §3.1, which are a separate
 * design goal):
 *
 * - **record** — the call is being journaled; the note is attached to the
 *   `GatewayCallRecord` (persisted with the trace) for audit / replay.
 * - **live**   — the call runs ephemerally (no journal); the note is returned
 *   as a *proposal* the host may relay/log, but it is NOT persisted.
 * - **replay** — the trace is being replayed; the collector is bypassed
 *   (returns null). The recorded behavior is already on the journal and is
 *   restored verbatim, so collection never perturbs replay (axioms A1/A2).
 */
export type CollectorPhase = "record" | "live" | "replay";

export class BehaviorCollector {
  /**
   * Collect a behavior note for one call.
   * @param phase   collector phase for this call
   * @param note    the structured observation (built by the gateway)
   * @param record  the journal record to attach to in "record" mode (omitted
   *                in "live" mode so nothing is persisted; ignored in "replay")
   * @returns the note in "record"/"live" mode, or null in "replay" (bypass).
   */
  public collect(
    phase: CollectorPhase,
    note: BehaviorNote,
    record?: GatewayCallRecord
  ): BehaviorNote | null {
    if (phase === "replay") return null; // bypass — replay restores from journal
    if (phase === "record") {
      if (record) record.behavior = note; // persist with the trace
      return note;
    }
    return note; // live: proposal only, not persisted
  }
}
