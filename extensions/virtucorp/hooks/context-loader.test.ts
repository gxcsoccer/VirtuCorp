import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockPluginApi, makeAgentContext } from "../test-helpers.js";
import { registerContextLoader } from "./context-loader.js";
import { resolveConfig } from "../config.js";
import { setRoleMetadata, clearRoleMetadata } from "../lib/role-metadata.js";

// Mock gh CLI calls for CEO digest
vi.mock("../lib/github-client.js", () => ({
  gh: vi.fn(async () => "[]"),
}));

// Mock sprint state loader
vi.mock("../services/sprint-scheduler.js", () => ({
  loadSprintState: vi.fn(async () => ({
    current: 2,
    startDate: "2026-03-01",
    endDate: "2026-03-14",
    milestone: 3,
    status: "executing",
  })),
}));

describe("context-loader hook", () => {
  let api: ReturnType<typeof createMockPluginApi>;
  const config = resolveConfig({
    github: { owner: "test-owner", repo: "test-repo" },
    projectDir: "/tmp/test-project",
    sprint: { durationDays: 7 },
  });

  beforeEach(() => {
    api = createMockPluginApi();
    registerContextLoader(api as never, config);
  });

  afterEach(() => {
    clearRoleMetadata("session-dev");
    clearRoleMetadata("session-pm");
  });

  test("registers a before_prompt_build hook", () => {
    expect(api.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
  });

  // ── Sub-agent context ─────────────────────────────────────

  test("injects role prompt and project context for Dev sub-agent", async () => {
    setRoleMetadata("session-dev", "dev");
    const event = { prompt: "do something", messages: [] };
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    const result = await api._callHook("before_prompt_build", event, ctx) as {
      prependSystemContext: string;
      prependContext: string;
    };

    expect(result).toBeDefined();
    expect(result.prependSystemContext).toContain("VirtuCorp Dev Agent");
    expect(result.prependContext).toContain("test-owner/test-repo");
    expect(result.prependContext).toContain("7 days");
  });

  test("injects PM role prompt for PM sessions", async () => {
    setRoleMetadata("session-pm", "pm");
    const event = { prompt: "plan sprint", messages: [] };
    const ctx = makeAgentContext({ sessionKey: "session-pm" });
    const result = await api._callHook("before_prompt_build", event, ctx) as {
      prependSystemContext: string;
    };

    expect(result.prependSystemContext).toContain("VirtuCorp PM Agent");
  });

  test("sub-agent context includes label conventions", async () => {
    setRoleMetadata("session-dev", "dev");
    const event = { prompt: "test", messages: [] };
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    const result = await api._callHook("before_prompt_build", event, ctx) as {
      prependContext: string;
    };

    expect(result.prependContext).toContain("status/ready-for-dev");
    expect(result.prependContext).toContain("priority/p0");
  });

  // ── CEO context ───────────────────────────────────────────

  test("injects CEO prompt and live digest for heartbeat trigger", async () => {
    const event = { prompt: "heartbeat", messages: [] };
    const ctx = { ...makeAgentContext({ sessionKey: "ceo-session" }), trigger: "heartbeat" };
    const result = await api._callHook("before_prompt_build", event, ctx) as {
      prependSystemContext: string;
      prependContext: string;
    };

    expect(result).toBeDefined();
    expect(result.prependSystemContext).toContain("VirtuCorp CEO Agent");
    expect(result.prependContext).toContain("Sprint 2");
    expect(result.prependContext).toContain("executing");
  });

  test("injects CEO context for user-triggered messages", async () => {
    const event = { prompt: "what should we do?", messages: [] };
    const ctx = { ...makeAgentContext({ sessionKey: "ceo-session" }), trigger: "user" };
    const result = await api._callHook("before_prompt_build", event, ctx) as {
      prependSystemContext: string;
      prependContext: string;
    };

    expect(result).toBeDefined();
    expect(result.prependSystemContext).toContain("CEO");
    expect(result.prependContext).toContain("Current Situation");
  });

  test("returns undefined for unknown trigger without role", async () => {
    const event = { prompt: "test", messages: [] };
    const ctx = { ...makeAgentContext({ sessionKey: "random" }), trigger: "cron" };
    const result = await api._callHook("before_prompt_build", event, ctx);
    expect(result).toBeUndefined();
  });
});
