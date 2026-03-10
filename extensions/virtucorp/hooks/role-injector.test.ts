import { describe, test, expect, beforeEach } from "vitest";
import {
  createMockPluginApi,
  makeSubagentSpawningEvent,
} from "../test-helpers.js";
import { registerRoleInjector } from "./role-injector.js";
import { getRoleMetadata, clearRoleMetadata } from "../lib/role-metadata.js";

describe("role-injector hook", () => {
  let api: ReturnType<typeof createMockPluginApi>;

  beforeEach(() => {
    api = createMockPluginApi();
    registerRoleInjector(api as never);
    clearRoleMetadata("child-session-1");
  });

  test("registers a subagent_spawning hook", () => {
    expect(api.on).toHaveBeenCalledWith("subagent_spawning", expect.any(Function));
  });

  test("sets role metadata for vc:dev label", async () => {
    const event = makeSubagentSpawningEvent({ label: "vc:dev" });
    const result = await api._callHook("subagent_spawning", event, {});

    expect(result).toEqual({ status: "ok" });
    expect(getRoleMetadata("child-session-1")).toBe("dev");
  });

  test("sets role metadata for vc:pm label", async () => {
    const event = makeSubagentSpawningEvent({ label: "vc:pm" });
    await api._callHook("subagent_spawning", event, {});
    expect(getRoleMetadata("child-session-1")).toBe("pm");
  });

  test("sets role metadata for vc:qa label", async () => {
    const event = makeSubagentSpawningEvent({ label: "vc:qa" });
    await api._callHook("subagent_spawning", event, {});
    expect(getRoleMetadata("child-session-1")).toBe("qa");
  });

  test("sets role metadata for vc:ops label", async () => {
    const event = makeSubagentSpawningEvent({ label: "vc:ops" });
    await api._callHook("subagent_spawning", event, {});
    expect(getRoleMetadata("child-session-1")).toBe("ops");
  });

  test("ignores non-vc labels", async () => {
    const event = makeSubagentSpawningEvent({ label: "other:dev" });
    const result = await api._callHook("subagent_spawning", event, {});
    expect(result).toBeUndefined();
    expect(getRoleMetadata("child-session-1")).toBeUndefined();
  });

  test("ignores events without label", async () => {
    const event = makeSubagentSpawningEvent({});
    const result = await api._callHook("subagent_spawning", event, {});
    expect(result).toBeUndefined();
  });

  test("returns error for unknown vc role", async () => {
    const event = makeSubagentSpawningEvent({ label: "vc:cfo" });
    const result = await api._callHook("subagent_spawning", event, {}) as { status: string; error: string };
    expect(result).toEqual({ status: "error", error: 'Unknown VirtuCorp role: cfo' });
  });

  test("uses correct child session key", async () => {
    const event = makeSubagentSpawningEvent({
      label: "vc:dev",
      childSessionKey: "custom-session-key",
    });
    await api._callHook("subagent_spawning", event, {});
    expect(getRoleMetadata("custom-session-key")).toBe("dev");
  });
});
