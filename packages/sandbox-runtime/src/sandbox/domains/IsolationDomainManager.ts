import { ChildProcessDomainTransport, type IDomainTransport } from "./transport";
import { DOMAIN_HOST_SHIM } from "./hostShim";
import { DomainUnitMissingError } from "./errors";
import {
  beginTransaction,
  markExecuted,
  reconcileTransactions as reconcileOf,
  stableHash,
  settleTransaction,
  ledgerHash as ledgerHashOf,
  type DomainReconciliation,
  type DomainTransaction,
  type DomainTxnDecision
} from "./transaction";
import type { ClockSource } from "@orbit/infra-common";
import {
  allocateDomains,
  type AllocateOptions,
  type IsolationDomainPlan,
  type IsolationDomainSpec
} from "./allocate";
import { IsolationDomain, type DomainInvokeCtx } from "./IsolationDomain";
import type { ImpactDomainGraph } from "../../graph/impact_domain";

/** Transport factory: how a new domain gets its host connection. */
export type DomainTransportFactory = (domainId: string) => IDomainTransport;

export interface IsolationDomainManagerOptions extends AllocateOptions {
  /**
   * Build the host transport for a new domain. Defaults to spawning the
   * built-in pure-unit host (`DOMAIN_HOST_SHIM`) with `node -e`.
   */
  transportFactory?: DomainTransportFactory;
  /** Per-call deadline when the caller supplies none. */
  defaultTimeoutMs?: number;
  /**
   * Clock used only to measure hop latency in the transaction ledger — it never
   * reaches a recorded value, so injecting one keeps tests deterministic.
   */
  clock?: ClockSource;
}

/**
 * Graph-driven isolation domain manager (W19).
 *
 * Owns the physical layer: recomputes the domain plan from the impact graph
 * (`syncDomains`), starts new domains, keeps unchanged ones, stops removed
 * ones, and routes unit invocations to the domain that owns the unit.
 *
 * The sync is a diff, not a rebuild: unchanged domains are never restarted
 * (their child processes stay up, so a plan recomputation after a small graph
 * change does not churn processes), and removed domains are awaited before
 * release — the same drain discipline the PAE registry uses for adapters.
 */
export class IsolationDomainManager {
  private readonly domains = new Map<string, IsolationDomain>();
  private readonly ownerOf = new Map<string, string>();
  private readonly transportFactory: DomainTransportFactory;
  private readonly options: IsolationDomainManagerOptions;
  private lastPlan: IsolationDomainPlan | null = null;
  private ledger: DomainTransaction[] = [];
  private txnSeq = 0;
  private readonly clock: ClockSource;

  public constructor(options: IsolationDomainManagerOptions = {}) {
    this.options = options;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.transportFactory =
      options.transportFactory ??
      ((domainId) =>
        new ChildProcessDomainTransport({
          command: process.execPath,
          args: ["-e", DOMAIN_HOST_SHIM]
        }));
  }

  /** Domains currently running, sorted by id. */
  public domainsOf(): Array<{ domainId: string; units: string[]; isolation: string }> {
    return [...this.domains.values()]
      .map((d) => ({
        domainId: d.domainId,
        units: d.describeUnits().map((u) => u.unitId),
        isolation: d.meta.isolation
      }))
      .sort((a, b) => a.domainId.localeCompare(b.domainId));
  }

  /**
   * The full unit-tool surface across all running domains, sorted. What the
   * gateway surface (`DomainChannel`) installs as dispatch methods.
   */
  public surface(): Array<{ unitId: string; tool: string }> {
    const out: Array<{ unitId: string; tool: string }> = [];
    for (const domain of this.domains.values()) {
      for (const unit of domain.describeUnits()) {
        for (const tool of unit.tools) out.push({ unitId: unit.unitId, tool });
      }
    }
    out.sort((a, b) => {
      const byUnit = a.unitId.localeCompare(b.unitId);
      return byUnit !== 0 ? byUnit : a.tool.localeCompare(b.tool);
    });
    return out;
  }

  /** The plan the last `syncDomains` produced; `null` before the first sync. */
  public planOf(): IsolationDomainPlan | null {
    return this.lastPlan;
  }

  /**
   * Stable hash of the current plan — domain ids plus their units. Empty when
   * no plan exists, so a host that never allocates domains keeps the exact
   * fingerprint it had before the physical layer existed (backward compatible,
   * same rule as the PAE adapter hash).
   */
  public planHash(): string {
    const plan = this.lastPlan;
    if (!plan) return "";
    const shape = plan.domains.map((d) => `${d.id}[${d.units.join(",")}]`).join(";");
    const escalated = plan.escalated.slice().sort().join(",");
    return stableHash(`${shape}|${escalated}`);
  }

  /**
   * Recompute the domain plan from the graph and reconcile the running set.
   * Idempotent per plan: calling twice with the same graph is a no-op.
   * `override` lets the host change allocation thresholds for a single sync.
   */
  public async syncDomains(
    graph: ImpactDomainGraph,
    ctx: DomainInvokeCtx,
    override: AllocateOptions = {}
  ): Promise<IsolationDomainPlan> {
    const options: AllocateOptions = {
      ...this.options,
      ...(override.maxImpactClosure !== undefined ? { maxImpactClosure: override.maxImpactClosure } : {}),
      ...(override.maxDomainSize !== undefined ? { maxDomainSize: override.maxDomainSize } : {})
    };
    const plan = allocateDomains(graph, options);
    const next = new Map<string, IsolationDomainSpec>();
    for (const spec of plan.domains) next.set(spec.id, spec);

    // Stop domains that are no longer in the plan (await their release).
    for (const [domainId, domain] of [...this.domains]) {
      if (next.has(domainId)) continue;
      await domain.teardown();
      this.domains.delete(domainId);
    }

    // Start domains that are new; keep the rest (setup is idempotent).
    for (const spec of plan.domains) {
      let domain = this.domains.get(spec.id);
      if (!domain) {
        domain = new IsolationDomain({
          domainId: spec.id,
          isolation: "L2",
          transport: this.transportFactory(spec.id),
          defaultTimeoutMs: this.options.defaultTimeoutMs
        });
        this.domains.set(spec.id, domain);
      }
      await domain.setup(ctx);
    }

    this.ownerOf.clear();
    for (const spec of plan.domains) {
      for (const unit of spec.units) {
        this.ownerOf.set(unit, spec.id);
      }
    }
    this.lastPlan = plan;
    return plan;
  }

  /**
   * Open a cross-domain transaction, execute the hop, and settle it — VISION
   * 2.1/2.2: every hop is `decision + execution + result + audit`, and the
   * ledger is what makes cross-domain interaction reconcilable after the fact.
   *
   * A refused hop (unit not assigned) is recorded as `rejected` rather than
   * thrown away, so "the plan no longer matches the graph" is visible in the
   * ledger instead of only in a stack trace.
   */
  public async invokeUnit(unitId: string, tool: string, args: unknown[], ctx: DomainInvokeCtx): Promise<unknown> {
    const domainId = this.ownerOf.get(unitId);
    const domain = domainId ? this.domains.get(domainId) : undefined;
    const targetDomain = domainId ?? "—";
    const isolation = domainId ? (this.domains.get(domainId)?.meta.isolation ?? "L2") : "—";

    const decision: DomainTxnDecision = domain
      ? { targetDomain, isolation, allowed: true }
      : {
          targetDomain,
          isolation: "—",
          allowed: false,
          reason: `no isolation domain owns unit ${unitId}; run syncDomains first`
        };

    let txn = beginTransaction({
      seq: this.txnSeq++,
      ctx,
      targetUnit: unitId,
      tool,
      decision,
      sourceUnit: ctx.pluginUnitId,
      sourceDomain: ctx.pluginUnitId ? this.ownerOf.get(ctx.pluginUnitId) : undefined
    });
    this.ledger.push(txn);

    if (!domain) {
      txn = settleTransaction(txn, { ok: false, error: decision.reason });
      this.ledger[this.ledger.length - 1] = txn;
      throw new DomainUnitMissingError(decision.reason ?? "domain call refused", ctx.traceMarkId);
    }

    txn = markExecuted(txn);
    const index = this.ledger.length - 1;
    this.ledger[index] = txn;

    const started = this.clock.now();
    try {
      const output = await domain.invokeUnit(unitId, tool, args, ctx);
      this.ledger[index] = settleTransaction(txn, {
        ok: true,
        latencyMs: Math.max(0, this.clock.now() - started)
      });
      return output;
    } catch (err) {
      this.ledger[index] = settleTransaction(txn, {
        ok: false,
        latencyMs: Math.max(0, this.clock.now() - started),
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  }

  /** Unit ids currently assigned to a domain, sorted. */
  public assignedUnits(): string[] {
    return [...this.ownerOf.keys()].sort();
  }

  /** The cross-domain transaction ledger, in transaction order. */
  public txnLedger(): readonly DomainTransaction[] {
    return this.ledger.slice();
  }

  /** Reconcile the ledger — see `reconcileTransactions` in ./transaction. */
  public reconcile(): DomainReconciliation {
    return reconcileOf(this.ledger);
  }

  /** Stable hash of the ledger, for drift checks. */
  public ledgerHash(): string {
    return ledgerHashOf(this.ledger);
  }

  /** Drop the ledger (e.g. between runs of the same host). */
  public clearLedger(): void {
    this.ledger = [];
    this.txnSeq = 0;
  }

  /** Stop every domain and release every host. */
  public async teardownAll(): Promise<void> {
    const domains = [...this.domains.values()];
    this.domains.clear();
    this.ownerOf.clear();
    this.lastPlan = null;
    for (const domain of domains) {
      try {
        await domain.teardown();
      } catch (err) {
        // Releasing a domain must not mask the release of the others.
        void err;
      }
    }
  }
}
