import { describe, test, expect } from "vitest";
import { resolveConfig } from "./config.js";

describe("resolveConfig", () => {
  test("resolves minimal valid config with defaults", () => {
    const config = resolveConfig({
      github: { owner: "acme", repo: "my-app" },
      projectDir: "/home/user/my-app",
    });

    expect(config.github.owner).toBe("acme");
    expect(config.github.repo).toBe("my-app");
    expect(config.projectDir).toBe("/home/user/my-app");
    expect(config.sprint.durationDays).toBe(14);
    expect(config.sprint.autoRetro).toBe(true);
    expect(config.budget.dailyLimitUsd).toBe(5);
    expect(config.budget.circuitBreakerRetries).toBe(3);
    expect(config.roles.pm.model).toBeUndefined();
    expect(config.roles.dev.model).toBeUndefined();
  });

  test("overrides defaults with provided values", () => {
    const config = resolveConfig({
      github: { owner: "acme", repo: "my-app" },
      projectDir: "/tmp/project",
      sprint: { durationDays: 7 },
      budget: { dailyLimitUsd: 10 },
      roles: {
        pm: { model: "claude-opus-4-6" },
        dev: { model: "qwen3-coder" },
      },
    });

    expect(config.sprint.durationDays).toBe(7);
    expect(config.sprint.autoRetro).toBe(true); // default preserved
    expect(config.budget.dailyLimitUsd).toBe(10);
    expect(config.budget.circuitBreakerRetries).toBe(3); // default preserved
    expect(config.roles.pm.model).toBe("claude-opus-4-6");
    expect(config.roles.dev.model).toBe("qwen3-coder");
    expect(config.roles.qa.model).toBeUndefined(); // unset role
  });

  test("throws when github config is missing", () => {
    expect(() => resolveConfig({})).toThrow("github.owner and github.repo are required");
  });

  test("throws when github.owner is missing", () => {
    expect(() => resolveConfig({ github: { repo: "my-app" } })).toThrow(
      "github.owner and github.repo are required",
    );
  });

  test("throws when projectDir is missing", () => {
    expect(() =>
      resolveConfig({ github: { owner: "acme", repo: "my-app" } }),
    ).toThrow("projectDir is required");
  });

  test("throws when config is undefined", () => {
    expect(() => resolveConfig(undefined)).toThrow("missing plugin config");
  });

  // ── Heartbeat auto-scaling ──────────────────────────────

  test("auto-scales heartbeat to 10min for daily sprint", () => {
    const config = resolveConfig({
      github: { owner: "a", repo: "b" },
      projectDir: "/tmp/p",
      sprint: { durationDays: 1 },
    });
    expect(config.sprint.heartbeatMinutes).toBe(10);
  });

  test("auto-scales heartbeat to 20min for 2-3 day sprint", () => {
    const config = resolveConfig({
      github: { owner: "a", repo: "b" },
      projectDir: "/tmp/p",
      sprint: { durationDays: 3 },
    });
    expect(config.sprint.heartbeatMinutes).toBe(20);
  });

  test("auto-scales heartbeat to 30min for weekly sprint", () => {
    const config = resolveConfig({
      github: { owner: "a", repo: "b" },
      projectDir: "/tmp/p",
      sprint: { durationDays: 7 },
    });
    expect(config.sprint.heartbeatMinutes).toBe(30);
  });

  test("auto-scales heartbeat to 60min for bi-weekly sprint", () => {
    const config = resolveConfig({
      github: { owner: "a", repo: "b" },
      projectDir: "/tmp/p",
      sprint: { durationDays: 14 },
    });
    expect(config.sprint.heartbeatMinutes).toBe(60);
  });

  test("respects explicit heartbeatMinutes override", () => {
    const config = resolveConfig({
      github: { owner: "a", repo: "b" },
      projectDir: "/tmp/p",
      sprint: { durationDays: 1, heartbeatMinutes: 5 },
    });
    expect(config.sprint.heartbeatMinutes).toBe(5);
  });
});
