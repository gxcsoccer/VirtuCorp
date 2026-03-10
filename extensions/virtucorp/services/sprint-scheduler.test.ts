import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  loadSprintState,
  saveSprintState,
  createInitialSprintState,
  isSprintExpired,
} from "./sprint-scheduler.js";
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
