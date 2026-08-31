/**
 * @orbit/sandbox-runtime — Sandboxed execution, the impact-domain graph and graph-driven isolation domains.
 *
 * This barrel is the package's public surface: other packages and the
 * root product import the package by name, never by relative path.
 */
export * from "./graph/impact_domain";
export * from "./sandbox/AgentSandbox";
export * from "./sandbox/domains/allocate";
export * from "./sandbox/domains/DomainChannel";
export * from "./sandbox/domains/errors";
export * from "./sandbox/domains/hostShim";
export * from "./sandbox/domains/IsolationDomain";
export * from "./sandbox/domains/IsolationDomainManager";
export * from "./sandbox/domains/protocol";
export * from "./sandbox/domains/transaction";
export * from "./sandbox/domains/transport";
export * from "./sandbox/SandboxPool";
