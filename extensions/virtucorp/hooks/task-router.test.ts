import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  createMockPluginApi,
  makeSubagentEndedEvent,
} from "../test-helpers.js";
import { registerTaskRouter } from "./task-router.js";
import { setRoleMetadata, getRoleMetadata, clearRoleMetadata } from "../lib/role-metadata.js";

describe("task-router hook", () => {
  let api: ReturnType<typeof createMockPluginApi>;

  beforeEach(() => {
    api = createMockPluginApi();
    registerTaskRouter(api as never);
  });

  afterEach(() => {
    clearRoleMetadata("child-session-1");
  });

  test("registers a subagent_ended hook", () => {
    expect(api.on).toHaveBeenCalledWith("subagent_ended", expect.any(Function));
  });

  test("clears role metadata on successful completion", async () => {
    setRoleMetadata("child-session-1", "dev");
    const event = makeSubagentEndedEvent({ outcome: "ok" });
    await api._callHook("subagent_ended", event, {});

    expect(getRoleMetadata("child-session-1")).toBeUndefined();
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("dev sub-agent completed successfully"),
    );
  });

  test("logs warning on failed completion", async () => {
    setRoleMetadata("child-session-1", "qa");
    const event = makeSubagentEndedEvent({ outcome: "error", error: "timeout" });
    await api._callHook("subagent_ended", event, {});

    expect(getRoleMetadata("child-session-1")).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('qa sub-agent ended with outcome "error": timeout'),
    );
  });

  test("ignores non-VirtuCorp sub-agents", async () => {
    const event = makeSubagentEndedEvent({ targetSessionKey: "unknown-session" });
    await api._callHook("subagent_ended", event, {});

    expect(api.logger.info).not.toHaveBeenCalled();
    expect(api.logger.warn).not.toHaveBeenCalled();
  });
});
