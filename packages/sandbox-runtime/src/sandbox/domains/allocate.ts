/**
 * Graph-driven isolation domain allocation (W19).
 *
 * VISION 2.3 "双层隔离": the logical layer (graph closure, A2) and the physical
 * layer (isolation domains) work together, and the **impact-domain closure
 * drives the isolation level** — a node whose failure can reach many others
 * must not be co-located with them in a process where a crash takes the whole
 * domain down.
 *
 * The failure impact of a node is its reverse-reachability closure on the
 * impact graph (`ImpactDomainGraph.closure`, edge direction dependent →
 * dependency). This module turns that graph into a domain plan:
 *
 * - nodes whose impact closure exceeds `maxImpactClosure` are **escalated** to
 *   their own isolated L2 domain (`iso:<unit>`);
 * - the remaining nodes — whose blast radius is bounded by the threshold — are
 *   packed into shared domains in deterministic chunks of at most
 *   `maxDomainSize`. Independence is what makes co-location safe: nodes with no
 *   path between them cannot affect each other, so sharing a process adds no
 *   *logical* blast; the threshold is the accepted *process-level* blast
 *   contract (a crash kills the co-located units, which is why big-closure
 *   nodes are never co-located);
 * - the whole computation is deterministic: ids are ordered, unit lists are
 *   sorted, so equal graphs always produce equal plans (a1-adjacent: the plan
 *   feeds observability and the run fingerprint).
 */

import type { ImpactDomainGraph } from "../../graph/impact_domain";

/** Physical isolation level of a domain. W19 ships `L2` (own OS process). */
export type DomainIsolationLevel = "L2" | "L1";

export interface IsolationDomainSpec {
  /** Stable domain id (`iso:<unit>` or `shared:<n>`). */
  id: string;
  isolation: DomainIsolationLevel;
  /** Unit ids assigned to this domain, sorted. */
  units: string[];
}

export interface IsolationDomainPlan {
  /** All domains, sorted by id. Every graph node appears in exactly one. */
  domains: IsolationDomainSpec[];
  /** Unit ids that were escalated to their own domain, sorted. */
  escalated: string[];
}

export interface AllocateOptions {
  /**
   * A node whose impact closure (number of other nodes its failure can reach)
   * exceeds this value is escalated to its own L2 domain. Default 1 — a unit
   * that can affect more than one other unit gets a private process.
   */
  maxImpactClosure?: number;
  /**
   * Shared domains are chunked to at most this many units. Default 3.
   */
  maxDomainSize?: number;
}

const DEFAULT_MAX_IMPACT_CLOSURE = 1;
const DEFAULT_MAX_DOMAIN_SIZE = 3;

/** Failure impact of every node: reverse-reachability closure sizes. */
export function impactClosureSizes(graph: ImpactDomainGraph): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const id of graph.nodes()) {
    sizes.set(id, graph.closure(id).size);
  }
  return sizes;
}

/**
 * Allocate the whole graph into a domain plan.
 *
 * Partition property: every graph node is assigned to exactly one domain, so
 * the plan is a true partition and unit ids stay globally unique — which is
 * what makes channel-level tool names (`unitId:tool`) collision-free.
 */
export function allocateDomains(
  graph: ImpactDomainGraph,
  options: AllocateOptions = {}
): IsolationDomainPlan {
  const maxClosure = options.maxImpactClosure ?? DEFAULT_MAX_IMPACT_CLOSURE;
  const maxDomainSize = options.maxDomainSize ?? DEFAULT_MAX_DOMAIN_SIZE;

  const escalated: string[] = [];
  const shareable: string[] = [];
  for (const id of graph.nodes()) {
    if (graph.closure(id).size > maxClosure) {
      escalated.push(id);
    } else {
      shareable.push(id);
    }
  }

  const domains: IsolationDomainSpec[] = escalated.map((unit) => ({
    id: `iso:${unit}`,
    isolation: "L2",
    units: [unit]
  }));

  // Pack the shareable nodes into deterministic chunks. Sorted order keeps the
  // plan stable regardless of insertion order (see the module comment for why
  // co-location of shareable nodes is safe by construction).
  const sortedShareable = shareable.sort();
  let sharedCount = 0;
  for (let i = 0; i < sortedShareable.length; i += maxDomainSize) {
    const chunk = sortedShareable.slice(i, i + maxDomainSize);
    if (chunk.length === 0) continue;
    domains.push({ id: `shared:${sharedCount}`, isolation: "L2", units: chunk });
    sharedCount += 1;
  }

  domains.sort((a, b) => a.id.localeCompare(b.id));
  return { domains, escalated: escalated.sort() };
}
