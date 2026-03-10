import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createMockPluginApi, makeAgentContext } from "../test-helpers.js";
import { registerUsageTracker } from "./usage-tracker.js";
import { setRoleMetadata, clearRoleMetadata } from "../lib/role-metadata.js";

describe("usage-tracker hook", () => {
  let api: ReturnType<typeof createMockPluginApi>;

  beforeEach(() => {
    api = createMockPluginApi();
  });

  afterEach(() => {
    clearRoleMetadata("session-dev");
  });

  test("registers an llm_output hook", () => {
    registerUsageTracker(api as never, { dailyLimitUsd: 5, circuitBreakerRetries: 3 });
    expect(api.on).toHaveBeenCalledWith("llm_output", expect.any(Function));
  });

  test("tracks usage for VirtuCorp sessions", async () => {
    registerUsageTracker(api as never, { dailyLimitUsd: 5, circuitBreakerRetries: 3 });
    setRoleMetadata("session-dev", "dev");

    const event = {
      runId: "run-1",
      sessionId: "sid-1",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      assistantTexts: ["hello"],
      usage: { total: 1000 },
    };
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    await api._callHook("llm_output", event, ctx);

    // Should not warn for small usage
    expect(api.logger.warn).not.toHaveBeenCalled();
  });

  test("warns when daily limit is exceeded", async () => {
    registerUsageTracker(api as never, { dailyLimitUsd: 0.001, circuitBreakerRetries: 3 });
    setRoleMetadata("session-dev", "dev");

    const event = {
      runId: "run-1",
      sessionId: "sid-1",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      assistantTexts: ["hello"],
      usage: { total: 10_000 }, // Should exceed $0.001 limit
    };
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    await api._callHook("llm_output", event, ctx);

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("daily budget limit exceeded"),
    );
  });

  test("ignores non-VirtuCorp sessions", async () => {
    registerUsageTracker(api as never, { dailyLimitUsd: 0.001, circuitBreakerRetries: 3 });

    const event = {
      runId: "run-1",
      sessionId: "sid-1",
      provider: "anthropic",
      model: "test",
      assistantTexts: ["hello"],
      usage: { total: 999_999_999 },
    };
    const ctx = makeAgentContext({ sessionKey: "no-role-session" });
    await api._callHook("llm_output", event, ctx);

    expect(api.logger.warn).not.toHaveBeenCalled();
  });

  test("ignores events with zero usage", async () => {
    registerUsageTracker(api as never, { dailyLimitUsd: 0.001, circuitBreakerRetries: 3 });
    setRoleMetadata("session-dev", "dev");

    const event = {
      runId: "run-1",
      sessionId: "sid-1",
      provider: "anthropic",
      model: "test",
      assistantTexts: [],
      usage: { total: 0 },
    };
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    await api._callHook("llm_output", event, ctx);

    expect(api.logger.warn).not.toHaveBeenCalled();
  });
});
