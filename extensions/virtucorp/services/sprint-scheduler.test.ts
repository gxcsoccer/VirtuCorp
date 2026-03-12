import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  loadSprintState,
  saveSprintState,
  createInitialSprintState,
  isSprintExpired,
  buildDigest,
  shouldDispatchToCEO,
  computeDigestHash,
} from "./sprint-scheduler.js";
import type { GitHubSummary } from "./sprint-scheduler.js";
import { createMockPluginApi } from "../test-helpers.js";
import { registerSprintScheduler } from "./sprint-scheduler.js";
import type { SprintState } from "../lib/types.js";

describe("sprint state persistence", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-sprint-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns null when no state file exists", async () => {
    const state = await loadSprintState(tmpDir);
    expect(state).toBeNull();
  });

  test("saves and loads sprint state", async () => {
    const state: SprintState = {
      current: 3,
      startDate: "2026-03-01",
      endDate: "2026-03-14",
      milestone: 5,
      status: "executing",
    };
    await saveSprintState(tmpDir, state);
    const loaded = await loadSprintState(tmpDir);
    expect(loaded).toEqual(state);
  });

  test("creates .virtucorp directory if missing", async () => {
    const state: SprintState = {
      current: 1,
      startDate: "2026-01-01",
      endDate: "2026-01-14",
      milestone: null,
      status: "planning",
    };
    await saveSprintState(tmpDir, state);
    const stat = await fs.stat(path.join(tmpDir, ".virtucorp"));
    expect(stat.isDirectory()).toBe(true);
  });
});

describe("createInitialSprintState", () => {
  test("creates Sprint 1 with correct dates", () => {
    const state = createInitialSprintState(1, 14);
    expect(state.current).toBe(1);
    expect(state.status).toBe("planning");
    expect(state.milestone).toBeNull();

    const start = new Date(state.startDate);
    const end = new Date(state.endDate);
    const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBe(14);
  });

  test("creates daily sprint", () => {
    const state = createInitialSprintState(5, 1);
    expect(state.current).toBe(5);
    const start = new Date(state.startDate);
    const end = new Date(state.endDate);
    const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBe(1);
  });
});

describe("isSprintExpired", () => {
  test("returns false for future end date", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const state: SprintState = {
      current: 1,
      startDate: "2026-01-01",
      endDate: tomorrow.toISOString().split("T")[0],
      milestone: null,
      status: "executing",
    };
    expect(isSprintExpired(state)).toBe(false);
  });

  test("returns true for past end date", () => {
    const state: SprintState = {
      current: 1,
      startDate: "2020-01-01",
      endDate: "2020-01-14",
      milestone: null,
      status: "executing",
    };
    expect(isSprintExpired(state)).toBe(true);
  });

  test("returns false when end date is tomorrow", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const state: SprintState = {
      current: 1,
      startDate: "2026-03-01",
      endDate: tomorrow.toISOString().split("T")[0],
      milestone: null,
      status: "executing",
    };
    expect(isSprintExpired(state)).toBe(false);
  });
});

// ── buildDigest tests ────────────────────────────────────────

function emptySummary(): GitHubSummary {
  return { readyForDev: 0, inProgress: 0, inReview: 0, openPRs: 0, p0Bugs: [], needsApprovalPRs: [], needsApprovalIssues: [] };
}

function baseState(overrides?: Partial<SprintState>): SprintState {
  return {
    current: 2,
    startDate: "2026-03-12",
    endDate: "2026-03-19",
    milestone: 3,
    status: "executing",
    ...overrides,
  };
}

describe("buildDigest", () => {
  test("returns spawn_pm_plan when no sprint state", () => {
    const digest = buildDigest(null, emptySummary());
    expect(digest?.action).toBe("spawn_pm_plan");
  });

  test("returns spawn_pm_retro when status is retro", () => {
    const digest = buildDigest(baseState({ status: "retro" }), emptySummary());
    expect(digest?.action).toBe("spawn_pm_retro");
  });

  test("returns spawn_qa_acceptance when status is review", () => {
    const digest = buildDigest(baseState({ status: "review" }), emptySummary());
    expect(digest?.action).toBe("spawn_qa_acceptance");
  });

  test("P0 bugs take priority over open PRs and ready-for-dev during execution", () => {
    const summary = {
      ...emptySummary(),
      openPRs: 3,
      readyForDev: 2,
      p0Bugs: [{ number: 45, title: "Production layout broken" }],
    };
    const digest = buildDigest(baseState(), summary);
    expect(digest?.action).toBe("spawn_dev_bugfix");
    expect(digest?.reason).toContain("#45");
  });

  test("P0 bugs block next Sprint planning when status is completed", () => {
    const summary = {
      ...emptySummary(),
      p0Bugs: [{ number: 48, title: "Page layout issue" }],
    };
    const digest = buildDigest(baseState({ status: "completed" }), summary);
    expect(digest?.action).toBe("spawn_dev_bugfix");
    expect(digest?.reason).toContain("completed");
    expect(digest?.reason).toContain("#48");
  });

  test("completed status without bugs triggers next Sprint planning", () => {
    const digest = buildDigest(baseState({ status: "completed" }), emptySummary());
    expect(digest?.action).toBe("spawn_pm_plan");
    expect(digest?.reason).toContain("Sprint 3");
  });

  test("open PRs trigger QA spawn when no P0 bugs", () => {
    const summary = { ...emptySummary(), openPRs: 2 };
    const digest = buildDigest(baseState(), summary);
    expect(digest?.action).toBe("spawn_qa");
  });

  test("ready-for-dev issues trigger dev spawn", () => {
    const summary = { ...emptySummary(), readyForDev: 1 };
    const digest = buildDigest(baseState(), summary);
    expect(digest?.action).toBe("spawn_dev");
  });

  test("returns null when nothing actionable", () => {
    const digest = buildDigest(baseState(), emptySummary());
    expect(digest).toBeNull();
  });

  test("meta-improvement issues trigger investor notification", () => {
    const summary = {
      ...emptySummary(),
      needsApprovalIssues: [{ number: 10, title: "Improve QA prompt" }],
    };
    const digest = buildDigest(baseState(), summary);
    expect(digest?.action).toBe("notify_investor_approval");
  });
});

describe("shouldDispatchToCEO", () => {
  function makeDigest(action: string, p0Bugs: Array<{ number: number; title: string }> = []) {
    return buildDigest(
      baseState(action === "spawn_pm_plan" ? { status: "completed" } : undefined),
      { ...emptySummary(), p0Bugs, readyForDev: action === "spawn_dev" ? 1 : 0 },
    )!;
  }

  test("dispatches when no previous dispatch", () => {
    const digest = makeDigest("spawn_dev");
    expect(shouldDispatchToCEO(digest, null)).toBe(true);
  });

  test("dispatches when state changes (different action)", () => {
    const digest1 = makeDigest("spawn_dev");
    const digest2 = buildDigest(baseState(), { ...emptySummary(), p0Bugs: [{ number: 1, title: "bug" }] })!;
    const record = { digestHash: computeDigestHash(digest1), timestamp: Date.now() };
    expect(shouldDispatchToCEO(digest2, record)).toBe(true);
  });

  test("blocks dispatch within cooldown for same state", () => {
    const digest = makeDigest("spawn_dev");
    const record = {
      digestHash: computeDigestHash(digest),
      timestamp: Date.now() - 10 * 60 * 1000, // 10 min ago
    };
    expect(shouldDispatchToCEO(digest, record, Date.now())).toBe(false);
  });

  test("allows dispatch after cooldown expires", () => {
    const digest = makeDigest("spawn_dev");
    const record = {
      digestHash: computeDigestHash(digest),
      timestamp: Date.now() - 31 * 60 * 1000, // 31 min ago
    };
    expect(shouldDispatchToCEO(digest, record, Date.now())).toBe(true);
  });

  test("dispatches immediately when new P0 bug appears", () => {
    const digest = buildDigest(baseState(), { ...emptySummary(), p0Bugs: [{ number: 45, title: "Layout bug" }, { number: 48, title: "CORS bug" }] })!;
    // Previous dispatch was for a single bug
    const singleBugDigest = buildDigest(baseState(), { ...emptySummary(), p0Bugs: [{ number: 45, title: "Layout bug" }] })!;
    const record = {
      digestHash: computeDigestHash(singleBugDigest),
      timestamp: Date.now(), // just dispatched
    };
    expect(shouldDispatchToCEO(digest, record)).toBe(true);
  });
});

describe("registerSprintScheduler", () => {
  test("registers a service with correct id", () => {
    const api = createMockPluginApi();
    const config = {
      github: { owner: "test", repo: "test" },
      projectDir: "/tmp/test",
      sprint: { durationDays: 14, autoRetro: true, heartbeatMinutes: 60 },
      budget: { dailyLimitUsd: 5, circuitBreakerRetries: 3 },
      roles: { pm: {}, dev: {}, qa: {}, ops: {} },
    };
    registerSprintScheduler(api as never, config);

    expect(api.registerService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "virtucorp-sprint-scheduler" }),
    );
  });
});
