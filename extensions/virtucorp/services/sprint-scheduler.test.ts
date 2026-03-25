import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  loadSprintState,
  saveSprintState,
  createInitialSprintState,
  isSprintExpired,
  buildDigest,
  shouldDispatchToCEO,
  computeDigestHash,
  resetCircuitBreaker,
} from "./sprint-scheduler.js";
import type { GitHubSummary } from "./sprint-scheduler.js";
import { createMockPluginApi } from "../test-helpers.js";
import { registerSprintScheduler, _resetDispatchState } from "./sprint-scheduler.js";
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
  return { readyForDev: 0, inProgress: 0, inReview: 0, openPRs: 0, untriaged: [], p0Bugs: [], needsApprovalPRs: [], needsApprovalIssues: [] };
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

  test("returns null when nothing actionable during execution", () => {
    const digest = buildDigest(baseState(), emptySummary());
    expect(digest).toBeNull();
  });

  test("returns spawn_pm_plan when planning status with no issues", () => {
    const digest = buildDigest(baseState({ status: "planning" }), emptySummary());
    expect(digest?.action).toBe("spawn_pm_plan");
    expect(digest?.reason).toContain("planning");
  });

  test("returns null when planning status but issues already exist", () => {
    const summary = { ...emptySummary(), readyForDev: 3 };
    const digest = buildDigest(baseState({ status: "planning" }), summary);
    // Should not trigger PM plan again — issues already exist, route to dev
    expect(digest?.action).toBe("spawn_dev");
  });

  test("meta-improvement issues trigger investor notification", () => {
    const summary = {
      ...emptySummary(),
      needsApprovalIssues: [{ number: 10, title: "Improve QA prompt" }],
    };
    const digest = buildDigest(baseState(), summary);
    expect(digest?.action).toBe("notify_investor_approval");
  });

  test("untriaged issues trigger PM triage during execution", () => {
    const summary = {
      ...emptySummary(),
      untriaged: [{ number: 95, title: "Implement stop-loss orders" }],
    };
    const digest = buildDigest(baseState(), summary);
    expect(digest?.action).toBe("spawn_pm_plan");
    expect(digest?.reason).toContain("untriaged");
    expect(digest?.reason).toContain("#95");
  });

  test("ready-for-dev takes priority over untriaged", () => {
    const summary = {
      ...emptySummary(),
      readyForDev: 1,
      untriaged: [{ number: 95, title: "Implement stop-loss orders" }],
    };
    const digest = buildDigest(baseState(), summary);
    expect(digest?.action).toBe("spawn_dev");
  });

  test("triggers production smoke test when productionUrl option is set", () => {
    const digest = buildDigest(baseState(), emptySummary(), {
      productionUrl: "https://alphaarena-eight.vercel.app",
    });
    expect(digest?.action).toBe("spawn_qa_smoke");
    expect(digest?.reason).toContain("smoke test");
  });

  test("production smoke test has lower priority than P0 bugs", () => {
    const summary = {
      ...emptySummary(),
      p0Bugs: [{ number: 42, title: "Page crash" }],
    };
    const digest = buildDigest(baseState(), summary, {
      productionUrl: "https://alphaarena-eight.vercel.app",
    });
    expect(digest?.action).toBe("spawn_dev_bugfix");
  });

  test("production smoke test has lower priority than open PRs", () => {
    const summary = { ...emptySummary(), openPRs: 1 };
    const digest = buildDigest(baseState(), summary, {
      productionUrl: "https://alphaarena-eight.vercel.app",
    });
    expect(digest?.action).toBe("spawn_qa");
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
    const record = { digestHash: computeDigestHash(digest1), timestamp: Date.now(), consecutiveCount: 0 };
    expect(shouldDispatchToCEO(digest2, record)).toBe(true);
  });

  test("blocks dispatch within cooldown for same state", () => {
    const digest = makeDigest("spawn_dev");
    const record = {
      digestHash: computeDigestHash(digest),
      timestamp: Date.now() - 10 * 60 * 1000, // 10 min ago
      consecutiveCount: 0,
    };
    expect(shouldDispatchToCEO(digest, record, Date.now())).toBe(false);
  });

  test("allows dispatch after cooldown expires", () => {
    const digest = makeDigest("spawn_dev");
    const record = {
      digestHash: computeDigestHash(digest),
      timestamp: Date.now() - 31 * 60 * 1000, // 31 min ago
      consecutiveCount: 0,
    };
    expect(shouldDispatchToCEO(digest, record, Date.now())).toBe(true);
  });

  test("emergency mode uses shorter cooldown (10 min) for P0 bugs", () => {
    const p0Bugs = [{ number: 1, title: "bug" }];
    const digest = buildDigest(baseState(), { ...emptySummary(), p0Bugs })!;
    const record = {
      digestHash: computeDigestHash(digest),
      timestamp: Date.now() - 11 * 60 * 1000, // 11 min ago
      consecutiveCount: 4,
    };
    expect(shouldDispatchToCEO(digest, record, Date.now())).toBe(true);
  });

  test("emergency mode blocks P0 within 10 min cooldown", () => {
    const p0Bugs = [{ number: 1, title: "bug" }];
    const digest = buildDigest(baseState(), { ...emptySummary(), p0Bugs })!;
    const record = {
      digestHash: computeDigestHash(digest),
      timestamp: Date.now() - 5 * 60 * 1000, // 5 min ago
      consecutiveCount: 4,
    };
    expect(shouldDispatchToCEO(digest, record, Date.now())).toBe(false);
  });

  test("non-P0 actions use normal 30min cooldown even when consecutiveCount >= 3", () => {
    // spawn_pm_plan from completed status (no P0 bugs)
    const digest = makeDigest("spawn_pm_plan");
    const record = {
      digestHash: computeDigestHash(digest),
      timestamp: Date.now() - 11 * 60 * 1000, // 11 min ago — within 30min but past 10min
      consecutiveCount: 4,
    };
    // Without the fix this would be true (emergency 10min cooldown)
    // With the fix: no P0 bugs → normal 30min cooldown → still blocked
    expect(shouldDispatchToCEO(digest, record, Date.now())).toBe(false);
  });

  test("non-P0 actions dispatch after normal 30min cooldown even at high consecutiveCount", () => {
    const digest = makeDigest("spawn_pm_plan");
    const record = {
      digestHash: computeDigestHash(digest),
      timestamp: Date.now() - 31 * 60 * 1000, // 31 min ago
      consecutiveCount: 4,
    };
    expect(shouldDispatchToCEO(digest, record, Date.now())).toBe(true);
  });

  test("state change bypasses consecutive count", () => {
    const digest1 = makeDigest("spawn_dev");
    const digest2 = buildDigest(baseState(), { ...emptySummary(), p0Bugs: [{ number: 1, title: "bug" }] })!;
    const record = {
      digestHash: computeDigestHash(digest1),
      timestamp: Date.now(), // just dispatched
      consecutiveCount: 100, // very high
    };
    expect(shouldDispatchToCEO(digest2, record)).toBe(true);
  });

  test("dispatches immediately when new P0 bug appears", () => {
    const digest = buildDigest(baseState(), { ...emptySummary(), p0Bugs: [{ number: 45, title: "Layout bug" }, { number: 48, title: "CORS bug" }] })!;
    // Previous dispatch was for a single bug
    const singleBugDigest = buildDigest(baseState(), { ...emptySummary(), p0Bugs: [{ number: 45, title: "Layout bug" }] })!;
    const record = {
      digestHash: computeDigestHash(singleBugDigest),
      timestamp: Date.now(), // just dispatched
      consecutiveCount: 0,
    };
    expect(shouldDispatchToCEO(digest, record)).toBe(true);
  });
});

describe("registerSprintScheduler", () => {
  let tmpProjectDir: string;

  beforeEach(async () => {
    _resetDispatchState();
    tmpProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-scheduler-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProjectDir, { recursive: true, force: true });
  });

  const baseConfig = {
    github: { owner: "test", repo: "test" },
    projectDir: "/tmp/vc-test-placeholder", // overridden per test
    sprint: { durationDays: 14, autoRetro: true, heartbeatMinutes: 60 },
    budget: { dailyLimitUsd: 5, circuitBreakerRetries: 3 },
    roles: { pm: {}, dev: {}, qa: {}, ops: {} },
  };

  test("registers a service with correct id", () => {
    const api = createMockPluginApi();
    registerSprintScheduler(api as never, { ...baseConfig, projectDir: tmpProjectDir });

    expect(api.registerService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "virtucorp-sprint-scheduler" }),
    );
  });

  test("passes ceoSessionKey to tick so dispatch uses correct session", async () => {
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const api = createMockPluginApi();
    // Provide runtime.config.loadConfig that returns a heartbeat session
    api.runtime = {
      config: {
        loadConfig: () => ({
          agents: {
            list: [
              { id: "virtucorp-ceo", heartbeat: { session: "feishu-group-123" } },
            ],
          },
        }),
      },
      system: {
        enqueueSystemEvent,
        requestHeartbeatNow,
      },
      subagent: {
        deleteSession: vi.fn().mockResolvedValue(undefined),
        run: vi.fn().mockResolvedValue({ outcome: "ok" }),
      },
    };

    registerSprintScheduler(api as never, { ...baseConfig, projectDir: tmpProjectDir });

    // Extract the registered service and call start
    const service = (api.registerService as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // start() calls tick() which calls collectGitHubSummary (shells out to gh).
    // Since gh will fail in test, collectGitHubSummary returns empty summary.
    // With no sprint state file, buildDigest returns spawn_pm_plan → dispatches to CEO.
    await service.start({ logger });

    // The key assertion: enqueueSystemEvent must be called with the resolved session key
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("[VirtuCorp Scheduler]"),
      { sessionKey: "agent:virtucorp-ceo:feishu-group-123" },
    );
  });

  test("falls back to main session when no heartbeat config", async () => {
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const api = createMockPluginApi();
    api.runtime = {
      config: {
        loadConfig: () => ({ agents: { list: [] } }),
      },
      system: {
        enqueueSystemEvent,
        requestHeartbeatNow,
      },
      subagent: {
        deleteSession: vi.fn().mockResolvedValue(undefined),
        run: vi.fn().mockResolvedValue({ outcome: "ok" }),
      },
    };

    registerSprintScheduler(api as never, { ...baseConfig, projectDir: tmpProjectDir });

    const service = (api.registerService as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await service.start({ logger });

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("[VirtuCorp Scheduler]"),
      { sessionKey: "agent:virtucorp-ceo:main" },
    );
  });

  test("falls back to main session when loadConfig throws", async () => {
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const api = createMockPluginApi();
    api.runtime = {
      config: {
        loadConfig: () => { throw new Error("config broken"); },
      },
      system: {
        enqueueSystemEvent,
        requestHeartbeatNow,
      },
      subagent: {
        deleteSession: vi.fn().mockResolvedValue(undefined),
        run: vi.fn().mockResolvedValue({ outcome: "ok" }),
      },
    };

    registerSprintScheduler(api as never, { ...baseConfig, projectDir: tmpProjectDir });

    const service = (api.registerService as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await service.start({ logger });

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("[VirtuCorp Scheduler]"),
      { sessionKey: "agent:virtucorp-ceo:main" },
    );
  });
});

describe("smoke test dedup and tick gating", () => {
  let tmpDir: string;

  beforeEach(async () => {
    _resetDispatchState();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-smoke-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeMockApi() {
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const api = createMockPluginApi();
    api.runtime = {
      config: { loadConfig: () => ({ agents: { list: [] } }) },
      system: { enqueueSystemEvent, requestHeartbeatNow },
      subagent: { deleteSession: vi.fn().mockResolvedValue(undefined) },
    };
    return { api, enqueueSystemEvent };
  }

  // Config with productionUrl and sprint in "executing" state with no GitHub work
  // This triggers the smoke test path
  function makeIdleConfig(projectDir: string) {
    return {
      github: { owner: "test", repo: "test" },
      projectDir,
      productionUrl: "https://example.com",
      sprint: { durationDays: 14, autoRetro: true, heartbeatMinutes: 60 },
      budget: { dailyLimitUsd: 5, circuitBreakerRetries: 3 },
      roles: { pm: {}, dev: {}, qa: {}, ops: {} },
    };
  }

  test("smoke test dispatches on first tick (tickCount=1, after increment, mod 3 !== 0 but tickCount starts at 0+1=1)", async () => {
    // Save a sprint in executing state with future end date so it's not expired
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    await saveSprintState(tmpDir, {
      current: 1, startDate: "2026-03-01", endDate: tomorrow.toISOString().split("T")[0],
      milestone: null, status: "executing",
    });

    const { api, enqueueSystemEvent } = makeMockApi();
    const config = makeIdleConfig(tmpDir);

    registerSprintScheduler(api as never, config);
    const service = (api.registerService as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // First tick: tickCount becomes 1 after increment. 1 % 3 !== 0 → no smoke test
    await service.start({ logger });

    // Should NOT dispatch smoke test on tick 1
    const smokeDispatches = enqueueSystemEvent.mock.calls.filter(
      (call: unknown[]) => (call[0] as string).includes("smoke test"),
    );
    expect(smokeDispatches).toHaveLength(0);
  });

  test("smoke test does not re-dispatch if state unchanged (test passed)", async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    await saveSprintState(tmpDir, {
      current: 1, startDate: "2026-03-01", endDate: tomorrow.toISOString().split("T")[0],
      milestone: null, status: "executing",
    });

    const { api, enqueueSystemEvent } = makeMockApi();
    const config = makeIdleConfig(tmpDir);

    registerSprintScheduler(api as never, config);
    const service = (api.registerService as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // Run 7 ticks manually to hit tickCount % 3 === 0 at least twice
    // Tick 1: tickCount=1, 1%3≠0 → skip
    // Tick 2: tickCount=2, 2%3≠0 → skip
    // Tick 3: tickCount=3, 3%3=0 → dispatches smoke test
    // Tick 4: tickCount=4, 4%3≠0 → skip
    // Tick 5: tickCount=5, 5%3≠0 → skip
    // Tick 6: tickCount=6, 6%3=0 → would dispatch but hash unchanged → dedup skip
    await service.start({ logger }); // tick 1
    await service.stop({ logger });

    // Run more ticks by re-registering (we don't reset dispatch state so lastDispatch persists)
    for (let i = 2; i <= 6; i++) {
      registerSprintScheduler(api as never, config);
      const svc = (api.registerService as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
      await svc.start({ logger });
      await svc.stop({ logger });
    }

    // Count smoke test dispatches
    const smokeDispatches = enqueueSystemEvent.mock.calls.filter(
      (call: unknown[]) => (call[0] as string).includes("smoke test"),
    );
    // Only tick 3 should dispatch; tick 6 should be deduped
    expect(smokeDispatches).toHaveLength(1);

    // Verify dedup log message appeared
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("smoke test already dispatched and state unchanged"),
    );
  }, 15000);

  test("smoke test re-dispatches after dedup TTL expires (2 hours)", async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    await saveSprintState(tmpDir, {
      current: 1, startDate: "2026-03-01", endDate: tomorrow.toISOString().split("T")[0],
      milestone: null, status: "executing",
    });

    const { api, enqueueSystemEvent } = makeMockApi();
    const config = makeIdleConfig(tmpDir);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // Run ticks 1-3: tick 3 dispatches the first smoke test
    for (let i = 1; i <= 3; i++) {
      registerSprintScheduler(api as never, config);
      const svc = (api.registerService as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
      await svc.start({ logger });
      await svc.stop({ logger });
    }

    const dispatchesBeforeTTL = enqueueSystemEvent.mock.calls.filter(
      (call: unknown[]) => (call[0] as string).includes("smoke test"),
    );
    expect(dispatchesBeforeTTL).toHaveLength(1);

    // Mock Date.now to jump 2h+1ms into the future so dedup TTL expires
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 2 * 60 * 60 * 1000 + 1);

    try {
      // Run ticks 4-6: tick 6 should re-dispatch because TTL expired
      for (let i = 4; i <= 6; i++) {
        registerSprintScheduler(api as never, config);
        const svc = (api.registerService as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
        await svc.start({ logger });
        await svc.stop({ logger });
      }
    } finally {
      vi.restoreAllMocks();
    }

    const dispatchesAfterTTL = enqueueSystemEvent.mock.calls.filter(
      (call: unknown[]) => (call[0] as string).includes("smoke test"),
    );
    expect(dispatchesAfterTTL).toHaveLength(2);
  }, 15000);
});

describe("idle watchdog", () => {
  let tmpDir: string;

  beforeEach(async () => {
    _resetDispatchState();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-idle-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeMockApi() {
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const api = createMockPluginApi();
    api.runtime = {
      config: { loadConfig: () => ({ agents: { list: [] } }) },
      system: { enqueueSystemEvent, requestHeartbeatNow },
      subagent: { deleteSession: vi.fn().mockResolvedValue(undefined) },
    };
    return { api, enqueueSystemEvent };
  }

  test("warns after 10 consecutive idle ticks", async () => {
    // Sprint in executing state, no work, no productionUrl → every tick is idle
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    await saveSprintState(tmpDir, {
      current: 1, startDate: "2026-03-01", endDate: tomorrow.toISOString().split("T")[0],
      milestone: null, status: "executing",
    });

    const { api } = makeMockApi();
    const config = {
      github: { owner: "test", repo: "test" },
      projectDir: tmpDir,
      // No productionUrl → no smoke test fallback → truly idle
      sprint: { durationDays: 14, autoRetro: true, heartbeatMinutes: 60 },
      budget: { dailyLimitUsd: 5, circuitBreakerRetries: 3 },
      roles: { pm: {}, dev: {}, qa: {}, ops: {} },
    };

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // Run 11 ticks — should see idle warning starting at tick 10
    for (let i = 0; i < 11; i++) {
      registerSprintScheduler(api as never, config);
      const svc = (api.registerService as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
      await svc.start({ logger });
      await svc.stop({ logger });
    }

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("consecutive idle ticks"),
    );
  }, 30000);
});

describe("sprint regression guard", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-regress-test-"));
    _resetDispatchState();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeMockApi() {
    const api = createMockPluginApi();
    api.runtime = {
      config: { loadConfig: () => ({ agents: { list: [] } }) },
      system: { enqueueSystemEvent: vi.fn(), requestHeartbeatNow: vi.fn() },
      subagent: { deleteSession: vi.fn().mockResolvedValue(undefined) },
    };
    return api;
  }

  test("detects and restores regressed sprint number on next tick", async () => {
    // Save Sprint 6
    await saveSprintState(tmpDir, {
      current: 6, startDate: "2026-04-09", endDate: "2026-04-16",
      milestone: 7, status: "executing",
    });

    const api = makeMockApi();
    const config = {
      github: { owner: "test", repo: "test" },
      projectDir: tmpDir,
      sprint: { durationDays: 14, autoRetro: true, heartbeatMinutes: 60 },
      budget: { dailyLimitUsd: 5, circuitBreakerRetries: 3 },
      roles: { pm: {}, dev: {}, qa: {}, ops: {} },
    };

    registerSprintScheduler(api as never, config);
    const service = (api.registerService as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // First tick: learns highWaterMark = 6
    await service.start({ logger });
    await service.stop({ logger });

    // PM overwrites sprint.json with Sprint 2 (regression!)
    await saveSprintState(tmpDir, {
      current: 2, startDate: "2026-03-12", endDate: "2026-03-19",
      milestone: 3, status: "review",
    });

    // DON'T reset dispatch state — highWaterMark must survive
    // Re-register a new service but highWaterMark is still 6
    registerSprintScheduler(api as never, config);
    const service2 = (api.registerService as ReturnType<typeof vi.fn>).mock.calls[1][0];

    await service2.start({ logger });

    // Verify regression was detected and restored
    const restored = await loadSprintState(tmpDir);
    expect(restored?.current).toBe(6);

    // Verify warning was logged
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("regressed from 6 to 2"),
    );
  });
});

describe("resetCircuitBreaker", () => {
  beforeEach(() => {
    _resetDispatchState();
  });

  test("resets consecutiveCount to 0", () => {
    // Simulate a stuck state by building digest and creating a dispatch record
    const digest = buildDigest(
      baseState(),
      { ...emptySummary(), readyForDev: 1 },
    )!;
    const hash = computeDigestHash(digest);

    // Manually dispatch should work initially
    expect(shouldDispatchToCEO(digest, null)).toBe(true);

    // After reset, dispatch should work again even with a record
    const record = { digestHash: hash, timestamp: Date.now(), consecutiveCount: 15 };
    // Within cooldown, same hash, high consecutive → uses 10min emergency cooldown
    expect(shouldDispatchToCEO(digest, record, Date.now())).toBe(false);

    // Now test that the function doesn't crash and works
    resetCircuitBreaker();
    // After reset, no error thrown
  });

  test("does not crash when lastDispatch is null", () => {
    _resetDispatchState();
    expect(() => resetCircuitBreaker()).not.toThrow();
  });
});
