import { describe, it, expect, beforeEach } from "vitest";
import { createMockPluginApi } from "../test-helpers.js";
import { registerBrowserTools } from "./browser.js";

describe("registerBrowserTools", () => {
  let api: ReturnType<typeof createMockPluginApi>;

  beforeEach(() => {
    api = createMockPluginApi();
    registerBrowserTools(api as never);
  });

  it("registers the vc_browse tool", () => {
    expect(api.registerTool).toHaveBeenCalledTimes(1);
    const tool = api._getTool("vc_browse");
    expect(tool).toBeDefined();
  });

  it("returns error for unknown action", async () => {
    const tool = api._getTool("vc_browse") as { execute: (id: string, args: Record<string, unknown>) => Promise<string> };
    const result = await tool.execute("test", { action: "unknown_action" });
    expect(result).toContain("Error: unknown action");
  });

  it("returns error when navigate is called without url", async () => {
    const tool = api._getTool("vc_browse") as { execute: (id: string, args: Record<string, unknown>) => Promise<string> };
    const result = await tool.execute("test", { action: "navigate" });
    expect(result).toContain("'url' parameter is required");
  });

  it("returns error when click is called without ref", async () => {
    const tool = api._getTool("vc_browse") as { execute: (id: string, args: Record<string, unknown>) => Promise<string> };
    const result = await tool.execute("test", { action: "click" });
    expect(result).toContain("'ref' parameter is required");
  });

  it("returns error when type is called without ref", async () => {
    const tool = api._getTool("vc_browse") as { execute: (id: string, args: Record<string, unknown>) => Promise<string> };
    const result = await tool.execute("test", { action: "type", text: "hello" });
    expect(result).toContain("'ref' parameter is required");
  });

  it("returns error when type is called without text", async () => {
    const tool = api._getTool("vc_browse") as { execute: (id: string, args: Record<string, unknown>) => Promise<string> };
    const result = await tool.execute("test", { action: "type", ref: "@e1" });
    expect(result).toContain("'text' parameter is required");
  });

  it("returns error when evaluate is called without javascript", async () => {
    const tool = api._getTool("vc_browse") as { execute: (id: string, args: Record<string, unknown>) => Promise<string> };
    const result = await tool.execute("test", { action: "evaluate" });
    expect(result).toContain("'javascript' parameter is required");
  });

  it("returns error when close_tab is called without tab", async () => {
    const tool = api._getTool("vc_browse") as { execute: (id: string, args: Record<string, unknown>) => Promise<string> };
    const result = await tool.execute("test", { action: "close_tab" });
    expect(result).toContain("'tab' parameter is required");
  });
});
