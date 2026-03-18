import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createMockPluginApi,
  makeAgentContext,
  makeToolCallEvent,
} from "../test-helpers.js";
import { registerSpawnCleanup } from "./spawn-cleanup.js";
import { setRoleMetadata, clearRoleMetadata } from "../lib/role-metadata.js";

describe("spawn-cleanup hook", () => {
  let api: ReturnType<typeof createMockPluginApi>;

  beforeEach(() => {
    api = createMockPluginApi();
    registerSpawnCleanup(api as never);
  });

  afterEach(() => {
    clearRoleMetadata("old-dev-session");
    clearRoleMetadata("old-qa-session");
  });

  test("deletes existing session when spawning same role", async () => {
    setRoleMetadata("old-dev-session", "dev");

    const event = makeToolCallEvent({
      toolName: "sessions_spawn",
      params: { label: "vc:dev", task: "Fix bug #100" },
    });
    const ctx = makeAgentContext({ sessionKey: "agent:virtucorp-ceo:main" });

    await api._callHook("before_tool_call", event, ctx);

    // Should have tried to delete the old session
    expect(api.runtime.subagent.deleteSession).toHaveBeenCalledWith({
      sessionKey: "old-dev-session",
    });
  });

  test("does not interfere when no existing session for role", async () => {
    const event = makeToolCallEvent({
      toolName: "sessions_spawn",
      params: { label: "vc:qa", task: "Review PR" },
    });
    const ctx = makeAgentContext({ sessionKey: "agent:virtucorp-ceo:main" });

    await api._callHook("before_tool_call", event, ctx);

    // Should NOT have called deleteSession
    expect(api.runtime.subagent.deleteSession).not.toHaveBeenCalled();
  });

  test("does not block the spawn (returns undefined)", async () => {
    setRoleMetadata("old-qa-session", "qa");

    const event = makeToolCallEvent({
      toolName: "sessions_spawn",
      params: { label: "vc:qa", task: "Review PR" },
    });
    const ctx = makeAgentContext({ sessionKey: "agent:virtucorp-ceo:main" });

    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toBeUndefined(); // Should not block
  });

  test("ignores non-spawn tool calls", async () => {
    setRoleMetadata("old-dev-session", "dev");

    const event = makeToolCallEvent({
      toolName: "read",
      params: { file_path: "/some/file.ts" },
    });
    const ctx = makeAgentContext({ sessionKey: "agent:virtucorp-ceo:main" });

    await api._callHook("before_tool_call", event, ctx);

    expect(api.runtime.subagent.deleteSession).not.toHaveBeenCalled();
  });

  test("ignores non-vc labels", async () => {
    const event = makeToolCallEvent({
      toolName: "sessions_spawn",
      params: { label: "other-label", task: "Something" },
    });
    const ctx = makeAgentContext({ sessionKey: "agent:virtucorp-ceo:main" });

    await api._callHook("before_tool_call", event, ctx);

    expect(api.runtime.subagent.deleteSession).not.toHaveBeenCalled();
  });

  test("handles deleteSession failure gracefully", async () => {
    setRoleMetadata("old-dev-session", "dev");
    (api.runtime.subagent.deleteSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("session not found"),
    );

    const event = makeToolCallEvent({
      toolName: "sessions_spawn",
      params: { label: "vc:dev", task: "Fix bug" },
    });
    const ctx = makeAgentContext({ sessionKey: "agent:virtucorp-ceo:main" });

    // Should not throw
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toBeUndefined();
  });
});
