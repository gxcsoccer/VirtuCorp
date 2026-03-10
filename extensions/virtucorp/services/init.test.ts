import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// Mock gh CLI calls
vi.mock("../lib/github-client.js", () => ({
  gh: vi.fn(async () => ""),
}));

import { initProject } from "./init.js";
import { loadSprintState } from "./sprint-scheduler.js";
import { gh } from "../lib/github-client.js";
import { LABELS } from "../lib/types.js";

const mockedGh = vi.mocked(gh);

describe("initProject", () => {
  let tmpDir: string;
  const githubConfig = { owner: "test", repo: "test-repo" };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-init-test-"));
    mockedGh.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("creates all required GitHub labels", async () => {
    await initProject(githubConfig, tmpDir, 14);

    // Should call gh for each label
    const labelCalls = mockedGh.mock.calls.filter(
      call => call[0][0] === "label" && call[0][1] === "create",
    );
    expect(labelCalls.length).toBeGreaterThanOrEqual(17); // 17 labels defined
  });

  test("creates label with correct args", async () => {
    await initProject(githubConfig, tmpDir, 14);

    const readyCall = mockedGh.mock.calls.find(
      call => call[0].includes(LABELS.STATUS_READY),
    );
    expect(readyCall).toBeDefined();
    expect(readyCall![0]).toContain("--force");
    expect(readyCall![0]).toContain("--color");
  });

  test("creates .virtucorp/knowledge directories", async () => {
    await initProject(githubConfig, tmpDir, 14);

    for (const cat of ["decisions", "patterns", "research", "runbook"]) {
      const stat = await fs.stat(path.join(tmpDir, ".virtucorp/knowledge", cat));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  test("creates .gitkeep files in knowledge dirs", async () => {
    await initProject(githubConfig, tmpDir, 14);

    for (const cat of ["decisions", "patterns", "research", "runbook"]) {
      const keepFile = path.join(tmpDir, ".virtucorp/knowledge", cat, ".gitkeep");
      const stat = await fs.stat(keepFile);
      expect(stat.isFile()).toBe(true);
    }
  });

  test("initializes Sprint 1 state", async () => {
    await initProject(githubConfig, tmpDir, 7);

    const state = await loadSprintState(tmpDir);
    expect(state).not.toBeNull();
    expect(state!.current).toBe(1);
    expect(state!.status).toBe("planning");

    const start = new Date(state!.startDate);
    const end = new Date(state!.endDate);
    const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBe(7);
  });

  test("returns log messages", async () => {
    const log = await initProject(githubConfig, tmpDir, 14);

    expect(log.some(l => l.includes("Creating GitHub labels"))).toBe(true);
    expect(log.some(l => l.includes("knowledge"))).toBe(true);
    expect(log.some(l => l.includes("Sprint 1"))).toBe(true);
    expect(log.some(l => l.includes("Done!"))).toBe(true);
  });

  test("handles label creation failure gracefully", async () => {
    mockedGh.mockRejectedValueOnce(new Error("API rate limit"));

    const log = await initProject(githubConfig, tmpDir, 14);

    // Should continue despite one label failing
    expect(log.some(l => l.includes("✗"))).toBe(true);
    expect(log.some(l => l.includes("Done!"))).toBe(true);
  });
});
