import { describe, expect, it } from "vitest";
import {
  createDefaultState,
  decideAfterFailure,
  migrateRecoveryState,
  promoteCandidate,
  type LegacyRecoveryState,
  type RecoveryState
} from "../electron/recovery-policy";
import type { RuntimeRef } from "../shared/contracts";

const bundled: RuntimeRef = {
  source: "bundled",
  version: "0.1.5-rc.2",
  binPath: "C:/app/bundled/bin.js"
};

const candidate: RuntimeRef = {
  source: "managed",
  version: "0.1.6-alpha.2",
  binPath: "C:/data/runtime/bin.js"
};

describe("recovery policy", () => {
  it("rolls a failed candidate back immediately", () => {
    const state: RecoveryState = {
      ...createDefaultState(bundled),
      active: candidate,
      candidate,
      activeHomeId: "slot-candidate",
      candidateHomeId: "slot-candidate"
    };
    const decision = decideAfterFailure(state, bundled, new Date("2026-09-21T08:00:00Z"));
    expect(decision.action).toBe("rollback");
    expect(decision.state.active).toEqual(bundled);
    expect(decision.state.activeHomeId).toBe("default");
    expect(decision.state.candidate).toBeUndefined();
    expect(decision.state.candidateHomeId).toBeUndefined();
    expect(decision.state.rollbackCount).toBe(1);
  });

  it("promotes only the active candidate", () => {
    const state: RecoveryState = {
      ...createDefaultState(bundled),
      active: candidate,
      candidate,
      activeHomeId: "slot-candidate",
      candidateHomeId: "slot-candidate"
    };
    const promoted = promoteCandidate(state, new Date("2026-09-21T08:01:00Z"));
    expect(promoted.lastKnownGood).toEqual(candidate);
    expect(promoted.lastKnownGoodHomeId).toBe("slot-candidate");
    expect(promoted.candidate).toBeUndefined();
  });

  it("clears stale crashes after a stable runtime survives probation", () => {
    const state: RecoveryState = {
      ...createDefaultState(bundled),
      crashTimestamps: ["2026-09-21T08:00:00Z"]
    };
    const healthy = promoteCandidate(state, new Date("2026-09-21T08:01:00Z"));
    expect(healthy.lastKnownGood).toEqual(bundled);
    expect(healthy.crashTimestamps).toEqual([]);
  });

  it("falls back to the bundled runtime after a managed crash loop", () => {
    let state: RecoveryState = {
      ...createDefaultState(bundled),
      active: candidate,
      lastKnownGood: candidate,
      activeHomeId: "slot-stable",
      lastKnownGoodHomeId: "slot-stable"
    };
    const first = decideAfterFailure(state, bundled, new Date("2026-09-21T08:00:00Z"));
    expect(first.action).toBe("retry");
    state = first.state;
    const second = decideAfterFailure(state, bundled, new Date("2026-09-21T08:00:20Z"));
    expect(second.action).toBe("retry");
    const third = decideAfterFailure(second.state, bundled, new Date("2026-09-21T08:00:40Z"));
    expect(third.action).toBe("fallback-bundled");
    expect(third.state.active).toEqual(bundled);
    expect(third.state.lastKnownGood).toEqual(bundled);
    expect(third.state.activeHomeId).toBe("default");
    expect(third.state.lastKnownGoodHomeId).toBe("default");
  });

  it("stops instead of looping forever when the bundled runtime is broken", () => {
    let state = createDefaultState(bundled);
    state = decideAfterFailure(state, bundled, new Date("2026-09-21T08:00:00Z")).state;
    state = decideAfterFailure(state, bundled, new Date("2026-09-21T08:00:10Z")).state;
    const final = decideAfterFailure(state, bundled, new Date("2026-09-21T08:00:20Z"));
    expect(final.action).toBe("stop");
  });

  it("migrates version-one state without losing its profile pointer", () => {
    const { activeHomeId, lastKnownGoodHomeId, candidateHomeId, ...current } = createDefaultState(bundled);
    void activeHomeId;
    void lastKnownGoodHomeId;
    void candidateHomeId;
    const legacy: LegacyRecoveryState = { ...current, schemaVersion: 1, candidate };
    const migrated = migrateRecoveryState(legacy);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.activeHomeId).toBe("default");
    expect(migrated.lastKnownGoodHomeId).toBe("default");
    expect(migrated.candidateHomeId).toBe("default");
  });
});
