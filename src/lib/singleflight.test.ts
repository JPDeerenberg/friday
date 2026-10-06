import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldRefresh,
  createSingleFlight,
  DASHBOARD_MIN_INTERVAL_MS,
} from "./singleflight.ts";

describe("shouldRefresh", () => {
  it("returns true on first load (null)", () => {
    assert.equal(shouldRefresh(null, 1000), true);
  });
  it("returns false within the min interval", () => {
    assert.equal(
      shouldRefresh(1000, 1000 + DASHBOARD_MIN_INTERVAL_MS - 1),
      false,
    );
  });
  it("returns true exactly at the interval boundary", () => {
    assert.equal(shouldRefresh(1000, 1000 + DASHBOARD_MIN_INTERVAL_MS), true);
  });
  it("returns true after the interval", () => {
    assert.equal(shouldRefresh(0, DASHBOARD_MIN_INTERVAL_MS + 5000), true);
  });
  it("honours a custom interval", () => {
    assert.equal(shouldRefresh(0, 500, 1000), false);
    assert.equal(shouldRefresh(0, 1000, 1000), true);
  });
});

describe("createSingleFlight", () => {
  it("collapses concurrent calls into one promise", async () => {
    const gate = createSingleFlight<number>();
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    };
    const [a, b, c] = await Promise.all([
      gate.run(fn),
      gate.run(fn),
      gate.run(fn),
    ]);
    assert.equal(a, 42);
    assert.equal(b, 42);
    assert.equal(c, 42);
    assert.equal(calls, 1);
  });
  it("runs again after the first settles", async () => {
    const gate = createSingleFlight<number>();
    let calls = 0;
    const fn = async () => {
      calls++;
      return calls;
    };
    assert.equal(await gate.run(fn), 1);
    assert.equal(await gate.run(fn), 2);
    assert.equal(calls, 2);
  });
  it("clears the slot on rejection so the next call retries", async () => {
    const gate = createSingleFlight<number>();
    let calls = 0;
    await assert.rejects(() =>
      gate.run(async () => {
        calls++;
        throw new Error("boom");
      }),
    );
    assert.equal(calls, 1);
    assert.equal(await gate.run(async () => 7), 7);
    assert.equal(calls, 1); // second fn does not increment `calls`
  });
});
