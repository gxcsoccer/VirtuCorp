import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createMockPluginApi, makeAgentContext } from "../test-helpers.js";
import { registerModelRouter } from "./model-router.js";
import { setRoleMetadata, clearRoleMetadata } from "../lib/role-metadata.js";
import type { VirtuCorpConfig } from "../lib/types.js";

const baseConfig: VirtuCorpConfig = {
  github: { owner: "test", repo: "test" },
  projectDir: "/tmp/test",
  sprint: { durationDays: 7, autoRetro: true, heartbeatMinutes: 30 },
  budget: { dailyLimitUsd: 5, circuitBreakerRetries: 3 },
  roles: {
    pm: { model: "bailian/qwen3.5-plus" },
    dev: { model: "bailian/qwen3-coder-plus" },
    qa: { model: "bailian/qwen3.5-plus" },
    ops: { model: "bailian/kimi-k2.5" },
  },
};

describe("model-router hook", () => {
  let api: ReturnType<typeof createMockPluginApi>;

  beforeEach(() => {
    api = createMockPluginApi();
    registerModelRouter(api as never, baseConfig);
  });

  afterEach(() => {
    clearRoleMetadata("session-dev");
    clearRoleMetadata("session-pm");
    clearRoleMetadata("session-qa");
    clearRoleMetadata("session-ops");
    clearRoleMetadata("session-ceo");
  });

  test("overrides model for Dev role", async () => {
    setRoleMetadata("session-dev", "dev");
    const event = { prompt: "implement feature" };
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    const result = (await api._callHook("before_model_resolve", event, ctx)) as {
      modelOverride?: string;
    };
    expect(result?.modelOverride).toBe("bailian/qwen3-coder-plus");
  });

  test("overrides model for PM role", async () => {
    setRoleMetadata("session-pm", "pm");
    const event = { prompt: "plan sprint" };
    const ctx = makeAgentContext({ sessionKey: "session-pm" });
    const result = (await api._callHook("before_model_resolve", event, ctx)) as {
      modelOverride?: string;
    };
    expect(result?.modelOverride).toBe("bailian/qwen3.5-plus");
  });

  test("overrides model for Ops role", async () => {
    setRoleMetadata("session-ops", "ops");
    const event = { prompt: "update docs" };
    const ctx = makeAgentContext({ sessionKey: "session-ops" });
    const result = (await api._callHook("before_model_resolve", event, ctx)) as {
      modelOverride?: string;
    };
    expect(result?.modelOverride).toBe("bailian/kimi-k2.5");
  });

  test("does not override model for CEO (no role)", async () => {
    const event = { prompt: "check status" };
    const ctx = makeAgentContext({ sessionKey: "session-ceo" });
    const result = await api._callHook("before_model_resolve", event, ctx);
    expect(result).toBeUndefined();
  });

  test("does not override when role has no model configured", async () => {
    const configNoModel: VirtuCorpConfig = {
      ...baseConfig,
      roles: {
        pm: { model: undefined },
        dev: { model: undefined },
        qa: { model: undefined },
        ops: { model: undefined },
      },
    };
    const api2 = createMockPluginApi();
    registerModelRouter(api2 as never, configNoModel);
    setRoleMetadata("session-dev", "dev");
    const event = { prompt: "code something" };
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    const result = await api2._callHook("before_model_resolve", event, ctx);
    expect(result).toBeUndefined();
    clearRoleMetadata("session-dev");
  });
});
