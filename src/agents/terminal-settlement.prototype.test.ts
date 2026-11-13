import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Executable design model only. It is not the storage or lifecycle implementation.
function createHost() {
  let current: object | undefined;
  return {
    start() {
      const generation = {};
      current = generation;
      let state: "live" | "terminal" | "archived" | "deleted" | "unknown" = "live";
      let pending = 0;
      let sealed = false;
      let resolve!: () => void;
      const settled = new Promise<void>((done) => {
        resolve = done;
      });
      const finish = () => {
        if (sealed && pending === 0) {
          resolve();
        }
      };
      return {
        setState(next: typeof state) {
          state = next;
        },
        admit() {
          if (current !== generation || sealed) {
            throw new Error("generation closed");
          }
          pending++;
          let released = false;
          return () => {
            if (!released) {
              released = true;
              pending--;
              finish();
            }
          };
        },
        async snapshot<T>(read: () => T): Promise<T> {
          const eligible = () =>
            current === generation && (state === "terminal" || state === "archived");
          if (!eligible() || sealed) {
            throw new Error("not eligible");
          }
          sealed = true;
          finish();
          await settled;
          if (!eligible()) {
            throw new Error("eligibility changed");
          }
          return read();
        },
      };
    },
  };
}

describe("terminal snapshot ordering model (not production)", () => {
  it("waits for accepted writes and seals new ones", async () => {
    const run = createHost().start();
    const release = run.admit();
    run.setState("terminal");
    let value = 0;
    const result = run.snapshot(() => value);
    assert.throws(() => run.admit(), /generation closed/);
    value = 42;
    release();
    release();
    assert.equal(await result, 42);
  });
  it("rejects a replaced generation before read", async () => {
    const host = createHost();
    const old = host.start();
    const release = old.admit();
    old.setState("terminal");
    const result = old.snapshot(() => "stale");
    host.start();
    release();
    await assert.rejects(result, /eligibility changed/);
  });
  for (const state of ["live", "deleted", "unknown"] as const) {
    it(`rejects ${state} state`, async () => {
      const run = createHost().start();
      run.setState(state);
      await assert.rejects(
        run.snapshot(() => "not read"),
        /not eligible/,
      );
    });
  }
  it("accepts an explicitly archived generation in this model", async () => {
    const run = createHost().start();
    run.setState("archived");
    assert.equal(await run.snapshot(() => "snapshot"), "snapshot");
  });
  for (const state of ["live", "deleted", "unknown"] as const) {
    it(`rejects a ${state} transition while an admitted writer settles`, async () => {
      const run = createHost().start();
      const release = run.admit();
      run.setState("archived");
      let reads = 0;
      const result = run.snapshot(() => {
        reads++;
      });
      run.setState(state);
      release();
      await assert.rejects(result, /eligibility changed/);
      assert.equal(reads, 0);
    });
  }
});
