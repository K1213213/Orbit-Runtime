/**
 * @orbit/infra-common — Domain contracts, pure utilities and error types. No kernel dependency, no runtime dependency.
 *
 * This barrel is the package's public surface: other packages and the
 * root product import the package by name, never by relative path.
 */
export * from "./core/orbitDomainError";
export * from "./types/orbitDomain";
export * from "./types/governance";
export * from "./utils/digest";
export * from "./utils/schema_validation";
export * from "./utils/versionIdGen";
