import type { RuntimeChannel, RuntimeRef, Sub2ApiSettings } from "../shared/contracts";

export interface RecoveryState {
  schemaVersion: 2;
  channel: RuntimeChannel;
  active: RuntimeRef;
  lastKnownGood: RuntimeRef;
  candidate?: RuntimeRef;
  activeHomeId: string;
  lastKnownGoodHomeId: string;
  candidateHomeId?: string;
  crashTimestamps: string[];
  rollbackCount: number;
  tokenSavingEnabled: boolean;
  sub2api?: Sub2ApiSettings;
  updatedAt: string;
}

export type LegacyRecoveryState = Omit<
  RecoveryState,
  "schemaVersion" | "activeHomeId" | "lastKnownGoodHomeId" | "candidateHomeId"
> & { schemaVersion: 1 };

export function migrateRecoveryState(state: RecoveryState | LegacyRecoveryState): RecoveryState {
  if (state.schemaVersion === 2) return state;
  return {
    ...state,
    schemaVersion: 2,
    activeHomeId: "default",
    lastKnownGoodHomeId: "default",
    candidateHomeId: state.candidate ? "default" : undefined
  };
}

export type RecoveryAction = "retry" | "rollback" | "fallback-bundled" | "stop";

export interface RecoveryDecision {
  action: RecoveryAction;
  state: RecoveryState;
}

const CRASH_WINDOW_MS = 5 * 60 * 1000;
const MAX_CRASHES = 3;

export function sameRuntime(left: RuntimeRef, right: RuntimeRef): boolean {
  return left.source === right.source && left.version === right.version;
}

export function createDefaultState(bundled: RuntimeRef): RecoveryState {
  return {
    schemaVersion: 2,
    channel: "stable",
    active: bundled,
    lastKnownGood: bundled,
    activeHomeId: "default",
    lastKnownGoodHomeId: "default",
    crashTimestamps: [],
    rollbackCount: 0,
    tokenSavingEnabled: true,
    sub2api: { enabled: false, allowedProfiles: [], powerShellPath: "" },
    updatedAt: new Date().toISOString()
  };
}

export function decideAfterFailure(
  current: RecoveryState,
  bundled: RuntimeRef,
  now = new Date()
): RecoveryDecision {
  const cutoff = now.getTime() - CRASH_WINDOW_MS;
  const crashTimestamps = [...current.crashTimestamps, now.toISOString()].filter(
    (item) => Date.parse(item) >= cutoff
  );

  if (current.candidate && sameRuntime(current.active, current.candidate)) {
    return {
      action: "rollback",
      state: {
        ...current,
        active: current.lastKnownGood,
        activeHomeId: current.lastKnownGoodHomeId,
        candidate: undefined,
        candidateHomeId: undefined,
        crashTimestamps,
        rollbackCount: current.rollbackCount + 1,
        updatedAt: now.toISOString()
      }
    };
  }

  if (crashTimestamps.length >= MAX_CRASHES) {
    if (current.active.source === "managed") {
      return {
        action: "fallback-bundled",
        state: {
          ...current,
          active: bundled,
          lastKnownGood: bundled,
          activeHomeId: "default",
          lastKnownGoodHomeId: "default",
          candidate: undefined,
          candidateHomeId: undefined,
          crashTimestamps: [],
          rollbackCount: current.rollbackCount + 1,
          updatedAt: now.toISOString()
        }
      };
    }

    return {
      action: "stop",
      state: {
        ...current,
        crashTimestamps,
        updatedAt: now.toISOString()
      }
    };
  }

  return {
    action: "retry",
    state: {
      ...current,
      crashTimestamps,
      updatedAt: now.toISOString()
    }
  };
}

export function promoteCandidate(current: RecoveryState, now = new Date()): RecoveryState {
  const activeCandidate = Boolean(current.candidate && sameRuntime(current.active, current.candidate));
  return {
    ...current,
    lastKnownGood: activeCandidate ? current.active : current.lastKnownGood,
    lastKnownGoodHomeId: activeCandidate ? current.activeHomeId : current.lastKnownGoodHomeId,
    candidate: activeCandidate ? undefined : current.candidate,
    candidateHomeId: activeCandidate ? undefined : current.candidateHomeId,
    crashTimestamps: [],
    updatedAt: now.toISOString()
  };
}
