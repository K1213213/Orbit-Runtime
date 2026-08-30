import { OrbitDomainError } from "../../core/orbitDomainError";

/** The domain host failed to deliver — transport, protocol or unit failure. */
export class DomainRemoteError extends OrbitDomainError {
  public constructor(message: string, traceMarkId?: string, domainId?: string) {
    super(message, "DOMAIN_REMOTE", traceMarkId, domainId);
  }
}

/** A unit or tool is not present in the assigned domains. */
export class DomainUnitMissingError extends OrbitDomainError {
  public constructor(message: string, traceMarkId?: string, domainId?: string) {
    super(message, "DOMAIN_UNIT_MISSING", traceMarkId, domainId);
  }
}
