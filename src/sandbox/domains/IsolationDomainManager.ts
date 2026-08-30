import { ChildProcessDomainTransport, type IDomainTransport } from "./transport";
import { DOMAIN_HOST_SHIM } from "./hostShim";
import { DomainUnitMissingError } from "./errors";
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

  public constructor(options: IsolationDomainManagerOptions = {}) {
    this.options = options;
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
   * Recompute the domain plan from the graph and reconcile the running set.
   * Idempotent per plan: calling twice with the same graph is a no-op.
   */
  public async syncDomains(graph: ImpactDomainGraph, ctx: DomainInvokeCtx): Promise<IsolationDomainPlan> {
    const plan = allocateDomains(graph, this.options);
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

  /** Route an invocation to the domain that owns the unit. */
  public async invokeUnit(unitId: string, tool: string, args: unknown[], ctx: DomainInvokeCtx): Promise<unknown> {
    const domainId = this.ownerOf.get(unitId);
    const domain = domainId ? this.domains.get(domainId) : undefined;
    if (!domain) {
      throw new DomainUnitMissingError(
        `no isolation domain owns unit ${unitId}; run syncDomains first`,
        ctx.traceMarkId
      );
    }
    return domain.invokeUnit(unitId, tool, args, ctx);
  }

  /** Unit ids currently assigned to a domain, sorted. */
  public assignedUnits(): string[] {
    return [...this.ownerOf.keys()].sort();
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
