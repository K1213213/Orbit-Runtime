import { test } from "node:test";
import assert from "node:assert/strict";
import { PluginPactVerifier } from "../src/pact/PluginPactVerifier";
import { PluginUnitPact } from "../src/types/orbitDomain";

const base: PluginUnitPact = {
  id: "p1",
  displayName: "P1",
  edition: "1.0.0",
  requireHostMinEdition: "1.0.0",
  allowCapabilities: ["channel:read"]
};

test("完整规约注册成功", () => {
  const verifier = new PluginPactVerifier();
  verifier.registerPluginUnit({ ...base }, "t1");
  assert.deepEqual(verifier.listPluginIds(), ["p1"]);
});

test("必填字段缺失被拒绝", () => {
  const verifier = new PluginPactVerifier();
  assert.throws(
    () => verifier.registerPluginUnit({ ...base, displayName: "" } as PluginUnitPact, "t1"),
    /missing mandatory fields/
  );
});

test("版本不满足宿主最低依赖被拒绝", () => {
  const verifier = new PluginPactVerifier();
  assert.throws(
    () => verifier.registerPluginUnit({ ...base, edition: "0.9.0" }, "t1"),
    /does not satisfy host edition/
  );
});

test("重复注册被拒绝", () => {
  const verifier = new PluginPactVerifier();
  verifier.registerPluginUnit({ ...base }, "t1");
  assert.throws(() => verifier.registerPluginUnit({ ...base }, "t1"), /already registered/);
});

test("能力声明鉴权", () => {
  const verifier = new PluginPactVerifier();
  verifier.registerPluginUnit({ ...base }, "t1");
  assert.equal(verifier.hasCapability("p1", "channel:read"), true);
  assert.equal(verifier.hasCapability("p1", "channel:write"), false);
  assert.equal(verifier.hasCapability("nobody", "channel:read"), false);
});
