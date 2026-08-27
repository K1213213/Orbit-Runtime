import { test } from "node:test";
import assert from "node:assert/strict";
import { TripProtector } from "../src/safeguard/TripProtector";
import { TripState } from "../src/types/orbitDomain";

test("连续失败达到阈值触发跳闸并快速拦截", async () => {
  const trip = new TripProtector(2, 10000);
  const fail = async (): Promise<string> => {
    throw new Error("boom");
  };
  await assert.rejects(trip.execWithProtect(fail));
  await assert.rejects(trip.execWithProtect(fail));
  assert.equal(trip.snapshot().state, TripState.TRIPPED);
  await assert.rejects(trip.execWithProtect(fail), /trip protector active/);
});

test("冷却后进入探测，单次成功即恢复", async () => {
  const trip = new TripProtector(1, 30);
  await assert.rejects(trip.execWithProtect(async () => {
    throw new Error("boom");
  }));
  assert.equal(trip.snapshot().state, TripState.TRIPPED);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const ok = await trip.execWithProtect(async () => "ok");
  assert.equal(ok, "ok");
  assert.equal(trip.snapshot().state, TripState.NORMAL);
});

test("成功后重置失败计数", async () => {
  const trip = new TripProtector(3, 10000);
  const fail = async (): Promise<string> => {
    throw new Error("x");
  };
  await assert.rejects(trip.execWithProtect(fail));
  await assert.rejects(trip.execWithProtect(fail));
  await trip.execWithProtect(async () => "ok");
  await assert.rejects(trip.execWithProtect(fail));
  assert.equal(trip.snapshot().state, TripState.NORMAL);
});
