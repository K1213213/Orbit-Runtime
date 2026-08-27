import { test } from "node:test";
import assert from "node:assert/strict";
import { ImpactDomainGraph } from "../src/graph/impact_domain";

test("closure: failure impact follows reverse edges (who depends on it)", () => {
  const g = new ImpactDomainGraph();
  g.addEdge("A", "B"); // A depends on B
  g.addEdge("B", "C"); // B depends on C
  assert.deepEqual([...g.closure("C")].sort(), ["A", "B"]); // C fails -> B, then A
  assert.deepEqual([...g.closure("A")], []); // A fails -> nobody depends on A
});

test("areIndependent: mutually unreachable nodes are provably independent", () => {
  const g = new ImpactDomainGraph();
  g.addEdge("p1", "kv-store");
  g.addEdge("p2", "llm-access");
  assert.equal(g.areIndependent("p1", "p2"), true);
});

test("areIndependent: shared dependency does not couple the dependents", () => {
  const g = new ImpactDomainGraph();
  g.addEdge("p1", "kv-store");
  g.addEdge("sandbox1", "kv-store");
  assert.equal(g.areIndependent("p1", "sandbox1"), true);
  assert.deepEqual([...g.closure("kv-store")].sort(), ["p1", "sandbox1"]);
});

test("outDegree: counts direct dependencies", () => {
  const g = new ImpactDomainGraph();
  g.addEdge("hub", "a");
  g.addEdge("hub", "b");
  g.addEdge("hub", "c");
  assert.equal(g.outDegree("hub"), 3);
  assert.equal(g.outDegree("unknown"), 0);
});

test("removeNode: drops the node and all incident edges", () => {
  const g = new ImpactDomainGraph();
  g.addEdge("p1", "kv-store");
  g.addEdge("sandbox1", "kv-store");
  g.removeNode("sandbox1");
  assert.equal(g.hasNode("sandbox1"), false);
  assert.deepEqual([...g.closure("kv-store")], ["p1"]);
  g.removeNode("kv-store");
  assert.equal(g.hasNode("kv-store"), false);
  assert.deepEqual([...g.closure("p1")], []);
});
