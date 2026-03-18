import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockPluginApi, makeToolCallEvent, makeAgentContext } from "../test-helpers.js";
import { registerModificationTracker, _resetAllStats, _getStats } from "./modification-tracker.js";
import { setRoleMetadata, clearRoleMetadata } from "../lib/role-metadata.js";

describe("modification-tracker (WTF-Likelihood)", () => {
  let api: ReturnType<typeof createMockPluginApi>;
  const sessionKey = "dev-session-1";

  beforeEach(() => {
    _resetAllStats();
    clearRoleMetadata(sessionKey);
    api = createMockPluginApi();
    registerModificationTracker(api as never, "/tmp/test-project");
    setRoleMetadata(sessionKey, "dev");
  });

  function callHook(toolName: string, command: string) {
    return api._callHook(
      "before_tool_call",
      makeToolCallEvent({ toolName, params: { command } }),
      makeAgentContext({ sessionKey }),
    );
  }

  it("ignores non-dev roles", async () => {
    clearRoleMetadata(sessionKey);
    setRoleMetadata(sessionKey, "qa");
    const result = await callHook("bash", "opencode -p 'fix bug' -q -c /tmp");
    expect(result).toBeUndefined();
  });

  it("ignores non-shell tools", async () => {
    const result = await api._callHook(
      "before_tool_call",
      makeToolCallEvent({ toolName: "read", params: { file_path: "/tmp/foo.ts" } }),
      makeAgentContext({ sessionKey }),
    );
    expect(result).toBeUndefined();
  });

  it("ignores non-opencode shell commands", async () => {
    const result = await callHook("bash", "npm test");
    expect(result).toBeUndefined();
    expect(_getStats(sessionKey)).toBeUndefined();
  });

  it("tracks opencode invocations", async () => {
    await callHook("bash", "opencode -p 'implement feature' -q -c /tmp");
    const stats = _getStats(sessionKey);
    expect(stats).toBeDefined();
    expect(stats!.modificationCount).toBe(1);
    expect(stats!.paused).toBe(false);
  });

  it("increments count across multiple invocations", async () => {
    for (let i = 0; i < 4; i++) {
      await callHook("bash", `opencode -p 'step ${i}' -q -c /tmp`);
    }
    const stats = _getStats(sessionKey);
    expect(stats!.modificationCount).toBe(4);
  });

  it("blocks after hard cap (50 modifications)", async () => {
    // Manually set count to 50
    _resetAllStats();
    // Re-register to get fresh hooks... actually we need to directly set
    // We'll simulate by calling 50 times. But that's slow. Let's use internal state.
    // Simpler: call once to init stats, then mutate
    await callHook("bash", "opencode -p 'init' -q -c /tmp");
    const stats = _getStats(sessionKey)!;
    stats.modificationCount = 50;

    const result = await callHook("bash", "opencode -p 'one more' -q -c /tmp");
    expect(result).toEqual(
      expect.objectContaining({
        block: true,
        blockReason: expect.stringContaining("HARD CAP"),
      }),
    );
  });

  it("blocks when paused flag is set", async () => {
    await callHook("bash", "opencode -p 'init' -q -c /tmp");
    const stats = _getStats(sessionKey)!;
    stats.paused = true;

    const result = await callHook("bash", "opencode -p 'another' -q -c /tmp");
    expect(result).toEqual(
      expect.objectContaining({
        block: true,
        blockReason: expect.stringContaining("PAUSED"),
      }),
    );
  });

  it("cleans up stats on subagent_ended", async () => {
    await callHook("bash", "opencode -p 'init' -q -c /tmp");
    expect(_getStats(sessionKey)).toBeDefined();

    // Simulate subagent ended
    const endedHandler = api._hooks.get("subagent_ended")?.[0];
    expect(endedHandler).toBeDefined();
    endedHandler!({ targetSessionKey: sessionKey });

    expect(_getStats(sessionKey)).toBeUndefined();
  });

  it("also detects execute_command tool name", async () => {
    const result = await api._callHook(
      "before_tool_call",
      makeToolCallEvent({ toolName: "execute_command", params: { command: "opencode -p 'x'" } }),
      makeAgentContext({ sessionKey }),
    );
    expect(result).toBeUndefined(); // Not blocked, just tracked
    expect(_getStats(sessionKey)!.modificationCount).toBe(1);
  });
});
