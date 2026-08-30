import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ChannelKind,
  DeterminismLevel,
  FetchHttpTransport,
  InMemoryHttpTransport,
  OpenApiPaeAdapter,
  OPENAPI_DEFAULT_FIDELITY_NOTE,
  OrbitRuntimeHost,
  PaeAdapterRejectError,
  PaeAdapterRegistry,
  PaeChannel,
  PaeRemoteError,
  PaeToolMissingError,
  bodyTail,
  buildHttpRequest,
  isHttpSuccess,
  normaliseHttpResponse,
  parseOpenApiDocument
} from "../src/index";
import type { IPaeAdapter, PaeInvokeCtx } from "../src/index";

/**
 * W17 — OpenAPI adapter suite.
 *
 * Three layers under test, kept separate like the MCP suite:
 *
 * 1. **spec** — pure parsing and request-building, so untrusted-document
 *    handling and URL determinism are verifiable without any I/O;
 * 2. **transport** — the real `fetch` path with a stubbed client, so status
 *    handling and deadlines are exercised without a live server;
 * 3. **adapter + host** — that a parsed foreign surface is registered, governed,
 *    recorded and replayed exactly like a native one, and that the transport is
 *    released on teardown.
 */

const CTX: PaeInvokeCtx = { traceMarkId: "tm-openapi", maxWaitMs: 1000 };

// ---------------------------------------------------------------------------
// Spec — parsing
// ---------------------------------------------------------------------------

const SAMPLE_DOC = {
  openapi: "3.0.1",
  info: { title: "Pet Store", version: "1.4.2" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/users/{id}": {
      get: {
        operationId: "getUser",
        summary: "Fetch a user",
        parameters: [{ name: "id", in: "path", required: true }]
      }
    },
    "/users": {
      get: {
        operationId: "listUsers",
        parameters: [
          { name: "limit", in: "query" },
          { name: "offset", in: "query" }
        ]
      },
      post: {
        operationId: "createUser",
        summary: "Create a user",
        requestBody: {}
      }
    },
    "/search": {
      get: {
        parameters: [{ name: "q", in: "query", required: true }]
      }
    }
  }
};

test("openapi spec: parses operations with ids, paths and parameters", () => {
  const parsed = parseOpenApiDocument(SAMPLE_DOC);
  const ids = parsed.operations.map((o) => o.id).sort();
  assert.deepEqual(ids, ["createUser", "getUser", "get_search", "listUsers"]);
  const getUser = parsed.operations.find((o) => o.id === "getUser")!;
  assert.equal(getUser.method, "get");
  assert.equal(getUser.path, "/users/{id}");
  assert.equal(getUser.parameters[0].name, "id");
  assert.equal(getUser.parameters[0].required, true);
  assert.equal(parsed.info.version, "1.4.2");
});

test("openapi spec: synthesizes an operation id when none is given", () => {
  const parsed = parseOpenApiDocument({
    openapi: "3.0.0",
    paths: { "/weird/path/{x}": { delete: {} } }
  });
  assert.equal(parsed.operations.length, 1);
  assert.equal(parsed.operations[0].id, "delete_weird_path__x");
});

test("openapi spec: rejects a document with no usable version", () => {
  assert.throws(
    () => parseOpenApiDocument({ paths: {} }),
    /neither `openapi` nor `swagger`/
  );
});

test("openapi spec: rejects duplicate operation ids", () => {
  assert.throws(
    () =>
      parseOpenApiDocument({
        openapi: "3.0.0",
        paths: { "/a": { get: { operationId: "dup" } }, "/b": { post: { operationId: "dup" } } }
      }),
    /duplicate operation id dup/
  );
});

test("openapi spec: rejects cookie parameters (kernel never sends ambient creds)", () => {
  assert.throws(
    () =>
      parseOpenApiDocument({
        openapi: "3.0.0",
        paths: { "/a": { get: { parameters: [{ name: "sid", in: "cookie" }] } } }
      }),
    /cookie parameter/
  );
});

test("openapi spec: path-level parameters merge into each operation", () => {
  const parsed = parseOpenApiDocument({
    openapi: "3.0.0",
    paths: {
      "/items/{itemId}": {
        parameters: [{ name: "itemId", in: "path", required: true }],
        get: { operationId: "getItem" }
      }
    }
  });
  const op = parsed.operations.find((o) => o.id === "getItem")!;
  assert.equal(op.parameters.length, 1);
  assert.equal(op.parameters[0].name, "itemId");
});

// ---------------------------------------------------------------------------
// Spec — request building
// ---------------------------------------------------------------------------

const GET_USER_OP = parseOpenApiDocument(SAMPLE_DOC).operations.find((o) => o.id === "getUser")!;
const LIST_USERS_OP = parseOpenApiDocument(SAMPLE_DOC).operations.find((o) => o.id === "listUsers")!;
const CREATE_USER_OP = parseOpenApiDocument(SAMPLE_DOC).operations.find((o) => o.id === "createUser")!;
const SEARCH_OP = parseOpenApiDocument(SAMPLE_DOC).operations.find((o) => o.id === "get_/search")!;

test("openapi spec: substitutes path params and rejects missing ones", () => {
  const req = buildHttpRequest(GET_USER_OP, [{ id: "42" }], "https://api.example.com/v1", "getUser", "a1");
  assert.equal(req.method, "GET");
  assert.equal(req.url, "https://api.example.com/v1/users/42");

  assert.throws(
    () => buildHttpRequest(GET_USER_OP, [{}], "https://api.example.com/v1", "getUser", "a1"),
    /missing required path parameter id/
  );
});

test("openapi spec: query params serialise in sorted order for digest stability", () => {
  const req = buildHttpRequest(LIST_USERS_OP, [{ limit: 10, offset: 5 }], "https://x.com", "listUsers", "a1");
  assert.match(req.url, /\?limit=10&offset=5$/);
});

test("openapi spec: remaining keys become the JSON body when a body is declared", () => {
  const req = buildHttpRequest(CREATE_USER_OP, [{ name: "Ada", email: "a@x.com" }], "https://x.com", "createUser", "a1");
  assert.equal(req.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(req.body!), { name: "Ada", email: "a@x.com" });
});

test("openapi spec: leftover args without a body are a hard error (no silent drop)", () => {
  assert.throws(
    () => buildHttpRequest(GET_USER_OP, [{ id: "1", surprise: true }], "https://x.com", "getUser", "a1"),
    /unknown argument\(s\): surprise/
  );
});

test("openapi spec: positional (non-object) args are rejected", () => {
  assert.throws(
    () => buildHttpRequest(GET_USER_OP, ["42"], "https://x.com", "getUser", "a1"),
    /expects a single named-argument object/
  );
});

test("openapi spec: non-JSON bodies normalise to a string, JSON parses to a value", () => {
  assert.deepEqual(normaliseHttpResponse(200, '{"ok":true}'), { value: { ok: true }, degraded: false });
  const raw = normaliseHttpResponse(200, "plain text");
  assert.equal(raw.value, "plain text");
  assert.equal(raw.degraded, true);
  assert.deepEqual(normaliseHttpResponse(204, ""), { value: null, degraded: false });
});

test("openapi spec: success predicate and body tail", () => {
  assert.equal(isHttpSuccess(200), true);
  assert.equal(isHttpSuccess(404), false);
  assert.equal(bodyTail("x".repeat(5000)).endsWith("… (5000 bytes total)"), true);
});

// ---------------------------------------------------------------------------
// Transport — real fetch path with a stubbed client
// ---------------------------------------------------------------------------

function fakeFetch(status: number, body: string) {
  return async (_url: string, _init: unknown) => ({
    status,
    text: async () => body
  });
}

test("openapi transport: InMemoryHttpTransport round-trips a request", async () => {
  let seen: unknown = null;
  const t = new InMemoryHttpTransport((req) => {
    seen = req;
    return { status: 200, body: JSON.stringify({ echoed: req.url }) };
  });
  const res = await t.send({ method: "GET", url: "https://x.com/a", headers: {} }, 1000);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { echoed: "https://x.com/a" });
  assert.ok(seen !== null);
  await t.close();
  await assert.rejects(() => t.send({ method: "GET", url: "x", headers: {} }, 1));
});

test("openapi transport: FetchHttpTransport maps status and body through the real path", async () => {
  const t = new FetchHttpTransport({
    baseUrl: "https://api.example.com",
    fetchImpl: fakeFetch(201, JSON.stringify({ id: 7 })) as unknown as typeof fetch
  });
  const res = await t.send({ method: "POST", url: "/users", headers: {}, body: "{}" }, 1000);
  assert.equal(res.status, 201);
  assert.deepEqual(JSON.parse(res.body), { id: 7 });
  await t.close();
});

// ---------------------------------------------------------------------------
// Adapter + host — registration, governance, recording, release
// ---------------------------------------------------------------------------

function makeAdapter(
  handler?: (req: { method: string; url: string; body?: string }) => { status: number; body: string },
  opts: { toolNamePrefix?: string; id?: string } = {}
) {
  return new OpenApiPaeAdapter({
    adapterId: opts.id ?? "openapi-petstore",
    document: SAMPLE_DOC,
    transport: new InMemoryHttpTransport((req) => {
      if (handler) return handler(req);
      return { status: 200, body: JSON.stringify({ url: req.url }) };
    }),
    toolNamePrefix: opts.toolNamePrefix
  });
}

test("openapi adapter: rejects missing identity, transport or document", () => {
  assert.throws(() => new OpenApiPaeAdapter({ adapterId: "", document: SAMPLE_DOC, transport: new InMemoryHttpTransport(() => ({ status: 200, body: "" })) }), /requires an adapterId/);
  assert.throws(() => new OpenApiPaeAdapter({ adapterId: "x", document: SAMPLE_DOC } as never), /requires a transport/);
  assert.throws(() => new OpenApiPaeAdapter({ adapterId: "x", transport: new InMemoryHttpTransport(() => ({ status: 200, body: "" })), document: null } as never), /requires an OpenAPI document/);
  assert.throws(
    () =>
      new OpenApiPaeAdapter({
        adapterId: "x",
        transport: new InMemoryHttpTransport(() => ({ status: 200, body: "" })),
        document: { openapi: "3.0.0", paths: { "/a": { get: { operationId: "a" } } } }
      }),
    /needs a baseUrl/
  );
});

test("openapi adapter: meta reports openapi kind, L2, semver edition, reduced default fidelity", () => {
  const a = makeAdapter();
  assert.equal(a.meta.kind, "openapi");
  assert.equal(a.meta.isolation, "L2");
  assert.equal(a.meta.sourceEdition, "1.4.2");
  const surface = a.describe();
  assert.equal(surface.length, 4);
  const getUser = surface.find((s) => s.name === "getUser")!;
  assert.equal(getUser.fidelity, "reduced");
  assert.equal(getUser.determinism, DeterminismLevel.IO_BOUND);
  assert.equal(getUser.fidelityNote, OPENAPI_DEFAULT_FIDELITY_NOTE);
});

test("openapi adapter: unknown tool is PaeToolMissingError, HTTP error is PaeRemoteError", async () => {
  const a = makeAdapter();
  await a.setup(CTX);
  await assert.rejects(() => a.invoke("nope", [], CTX), (e: unknown) => e instanceof PaeToolMissingError);

  const failing = new OpenApiPaeAdapter({
    adapterId: "openapi-fail",
    document: SAMPLE_DOC,
    baseUrl: "https://x.com",
    transport: new InMemoryHttpTransport(() => ({ status: 404, body: '{"error":"not found"}' }))
  });
  await failing.setup(CTX);
  await assert.rejects(() => failing.invoke("getUser", [{ id: "1" }], CTX), (e: unknown) => {
    if (!(e instanceof PaeRemoteError)) return false;
    return /HTTP 404/.test(e.message);
  });
});

test("openapi adapter: teardown releases the transport", async () => {
  const transport = new InMemoryHttpTransport(() => ({ status: 200, body: "" }));
  const a = new OpenApiPaeAdapter({
    adapterId: "openapi-close",
    document: SAMPLE_DOC,
    transport
  });
  await a.setup(CTX);
  assert.equal(a.isConnected, true);
  await a.teardown();
  assert.equal(a.isConnected, false);
  assert.equal(transport.closed, true);
});

test("openapi adapter: two adapters need a toolNamePrefix to avoid collision", async () => {
  const r1 = new PaeAdapterRegistry();
  const a1 = makeAdapter();
  await a1.setup(CTX);
  r1.register(a1);
  const a2 = makeAdapter(undefined, { toolNamePrefix: "v2_", id: "openapi-petstore-2" });
  await a2.setup(CTX);
  r1.register(a2);
  assert.equal(r1.listAdapters().length, 2);
});

test("openapi adapter: host routes a call through the gateway like a native tool", async () => {
  const adapter = makeAdapter();
  const host = new OrbitRuntimeHost();
  await host.connectPaeToolAdapter(adapter);
  const out = await host.capabilityInvoke<{ url: string }>({
    kind: ChannelKind.PAE_TOOL,
    pluginId: "openapi-petstore",
    funcName: "getUser",
    args: [{ id: "9" }],
    mode: "record"
  });
  assert.deepEqual(out, { url: "https://api.example.com/v1/users/9" });
  await host.unregisterPaeToolAdapter("openapi-petstore");
});
