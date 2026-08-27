/**
 * Fault impact domain kernel.
 *
 * Edge direction: `dependent → dependency` (a plugin depends on a channel).
 * Failure propagates BACKWARD: when a dependency fails, everyone depending on
 * it (transitively) is affected. The impact of a failing node is therefore its
 * reverse-reachability closure, and nodes outside that closure are provably
 * unaffected — the isolation theorem.
 */
export class ImpactDomainGraph {
  private readonly dependencies = new Map<string, Set<string>>();
  private readonly dependents = new Map<string, Set<string>>();

  public addNode(id: string): void {
    if (!this.dependencies.has(id)) {
      this.dependencies.set(id, new Set());
    }
    if (!this.dependents.has(id)) {
      this.dependents.set(id, new Set());
    }
  }

  /** `dependent` depends on `dependency`. */
  public addEdge(dependent: string, dependency: string): void {
    this.addNode(dependent);
    this.addNode(dependency);
    this.dependencies.get(dependent)!.add(dependency);
    this.dependents.get(dependency)!.add(dependent);
  }

  /** Remove a node and every incident edge (e.g. when a sandbox is dropped). */
  public removeNode(id: string): void {
    for (const dependency of this.dependencies.get(id) ?? []) {
      this.dependents.get(dependency)?.delete(id);
    }
    for (const dependent of this.dependents.get(id) ?? []) {
      this.dependencies.get(dependent)?.delete(id);
    }
    this.dependencies.delete(id);
    this.dependents.delete(id);
  }

  /** Failure impact of `from`: every node that (transitively) depends on it. */
  public closure(from: string): Set<string> {
    const visited = new Set<string>();
    const queue = [from];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of this.dependents.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    visited.delete(from);
    return visited;
  }

  /** Isolation theorem: a and b are independent iff neither's failure reaches the other. */
  public areIndependent(a: string, b: string): boolean {
    return !this.closure(a).has(b) && !this.closure(b).has(a);
  }

  /** How many channels a node depends on; drives per-plugin protection strictness. */
  public outDegree(id: string): number {
    return this.dependencies.get(id)?.size ?? 0;
  }

  public hasNode(id: string): boolean {
    return this.dependencies.has(id);
  }

  public clear(): void {
    this.dependencies.clear();
    this.dependents.clear();
  }
}
