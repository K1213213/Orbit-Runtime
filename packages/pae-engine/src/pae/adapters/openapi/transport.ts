/**
 * HTTP transports for the OpenAPI adapter (W17).
 *
 * The transport is an injected dependency rather than something the adapter
 * constructs inline — the same seam that makes the MCP adapter testable. With
 * `IHttpTransport` in place, the adapter's request-building and error semantics
 * are exercised against `InMemoryHttpTransport`, and the real network wiring is
 * a thin, separately-reviewable shell.
 */

import { PaeRemoteError } from "../../types";

/** One outbound HTTP request, fully resolved (no template left). */
export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** A response with the body read as text. Status/headers are not part of the value. */
export interface HttpResponse {
  status: number;
  body: string;
}

/** The seam the adapter talks through. */
export interface IHttpTransport {
  /** Send a request and wait for a response, bounded by `timeoutMs`. */
  send(request: HttpRequest, timeoutMs: number): Promise<HttpResponse>;
  /** Release the underlying resource. Idempotent. */
  close(): Promise<void>;
  readonly closed: boolean;
}

/** In-memory handler used by tests. */
export type HttpHandler = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

export class InMemoryHttpTransport implements IHttpTransport {
  private _closed = false;
  public constructor(private readonly handler: HttpHandler) {
    if (typeof handler !== "function") {
      throw new Error("in-memory http transport requires a handler");
    }
  }

  public get closed(): boolean {
    return this._closed;
  }

  public async send(request: HttpRequest, _timeoutMs: number): Promise<HttpResponse> {
    if (this._closed) {
      throw new PaeRemoteError(`http transport is closed (${request.method} ${request.url})`);
    }
    return this.handler(request);
  }

  public async close(): Promise<void> {
    this._closed = true;
  }
}

export interface FetchHttpTransportOptions {
  /** Default headers merged onto every request (e.g. `authorization`). */
  headers?: Record<string, string>;
  /** fetch implementation; defaults to `globalThis.fetch`. Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Base URL prefix applied to every request URL. */
  baseUrl?: string;
}

/**
 * Real-network transport backed by the platform `fetch`.
 *
 * The deadline uses an `AbortController` + timer. Note the same boundary as the
 * MCP stdio transport: the clock here is a *deadline* concern, not a
 * determinism concern — nothing computed from it reaches a recorded value.
 */
export class FetchHttpTransport implements IHttpTransport {
  private _closed = false;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  public constructor(options: FetchHttpTransportOptions = {}) {
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? "";
  }

  public get closed(): boolean {
    return this._closed;
  }

  public async send(request: HttpRequest, timeoutMs: number): Promise<HttpResponse> {
    if (this._closed) {
      throw new PaeRemoteError(`http transport is closed (${request.method} ${request.url})`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = this.baseUrl.replace(/\/+$/, "") + request.url;
      const res = await this.fetchImpl(url, {
        method: request.method,
        headers: { ...this.headers, ...request.headers },
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal: controller.signal
      });
      return { status: res.status, body: await res.text() };
    } catch (err) {
      throw new PaeRemoteError(
        `http request to ${request.method} ${request.url} failed: ${String(err instanceof Error ? err.message : err)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  public async close(): Promise<void> {
    this._closed = true;
  }
}
