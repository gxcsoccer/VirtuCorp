import { describe, test, expect } from "vitest";
import { createMockPluginApi } from "./test-helpers.js";
import plugin from "./index.js";

describe("VirtuCorp plugin", () => {
  test("has correct metadata", () => {
    expect(plugin.id).toBe("virtucorp");
    expect(plugin.name).toBe("VirtuCorp");
    expect(plugin.version).toBe("0.1.0");
  });

  test("registers successfully with valid config", async () => {
    const api = createMockPluginApi({
      github: { owner: "test", repo: "test-repo" },
      projectDir: "/tmp/test",
    });
    await plugin.register(api as never);

    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("initializing for test/test-repo"),
    );
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("plugin registered successfully"),
    );
  });

  test("registers PR tools (vc_review_pr, vc_merge_pr)", async () => {
    const api = createMockPluginApi({
      github: { owner: "test", repo: "test-repo" },
      projectDir: "/tmp/test",
    });
    await plugin.register(api as never);

    expect(api._getTool("vc_review_pr")).toBeDefined();
    expect(api._getTool("vc_merge_pr")).toBeDefined();
  });

  test("registers knowledge tools", async () => {
    const api = createMockPluginApi({
      github: { owner: "test", repo: "test-repo" },
      projectDir: "/tmp/test",
    });
    await plugin.register(api as never);

    expect(api._getTool("vc_save_knowledge")).toBeDefined();
    expect(api._getTool("vc_search_knowledge")).toBeDefined();
    expect(api._getTool("vc_list_knowledge")).toBeDefined();
  });

  test("registers all required hooks", async () => {
    const api = createMockPluginApi({
      github: { owner: "test", repo: "test-repo" },
      projectDir: "/tmp/test",
    });
    await plugin.register(api as never);

    const registeredHooks = api.on.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(registeredHooks).toContain("subagent_spawning");
    expect(registeredHooks).toContain("before_model_resolve");
    expect(registeredHooks).toContain("before_prompt_build");
    expect(registeredHooks).toContain("before_tool_call");
    expect(registeredHooks).toContain("subagent_ended");
    expect(registeredHooks).toContain("llm_output");
  });

  test("registers sprint scheduler service", async () => {
    const api = createMockPluginApi({
      github: { owner: "test", repo: "test-repo" },
      projectDir: "/tmp/test",
    });
    await plugin.register(api as never);

    expect(api.registerService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "virtucorp-sprint-scheduler" }),
    );
  });

  test("registers vc-init command", async () => {
    const api = createMockPluginApi({
      github: { owner: "test", repo: "test-repo" },
      projectDir: "/tmp/test",
    });
    await plugin.register(api as never);

    expect(api.registerCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: "vc-init" }),
    );
  });

  test("registers vc-reset command", async () => {
    const api = createMockPluginApi({
      github: { owner: "test", repo: "test-repo" },
      projectDir: "/tmp/test",
    });
    await plugin.register(api as never);

    expect(api.registerCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: "vc-reset" }),
    );
  });

  test("throws on missing config", () => {
    const api = createMockPluginApi(undefined);
    // pluginConfig is undefined
    (api as Record<string, unknown>).pluginConfig = undefined;
    expect(() => plugin.register(api as never)).toThrow("missing plugin config");
  });
});
