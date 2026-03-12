import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createMockPluginApi } from "../test-helpers.js";
import { registerUIAcceptanceTools } from "./ui-acceptance.js";

describe("ui-acceptance tools", () => {
  let api: ReturnType<typeof createMockPluginApi>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-ui-accept-test-"));
    api = createMockPluginApi();
    registerUIAcceptanceTools(api as never, tmpDir);
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("registers three UI acceptance tools", () => {
    expect(api._getTool("vc_ui_accept")).toBeDefined();
    expect(api._getTool("vc_ui_accept_run")).toBeDefined();
    expect(api._getTool("vc_ui_accept_list")).toBeDefined();
  });

  // ── vc_ui_accept: YAML generation ─────────────────────────

  test("generates valid YAML and saves when save_as is provided", async () => {
    const tool = api._getTool("vc_ui_accept")!;

    // The tool will try to run midscene which isn't installed, so it will fail.
    // But we can verify the YAML file was created and persisted (save_as keeps it).
    const result = await tool.execute("test",{
      url: "https://example.com",
      tasks: [
        {
          name: "Check homepage",
          flow: [
            { aiAssert: "Page has a title" },
            { sleep: 1000 },
          ],
        },
      ],
      save_as: "homepage-test",
    });

    expect(result).toContain("homepage-test.yaml");

    // Verify the YAML file was created and persisted
    const yamlPath = path.join(tmpDir, ".virtucorp/acceptance/homepage-test.yaml");
    const content = await fs.readFile(yamlPath, "utf-8");
    expect(content).toContain('url: "https://example.com"');
    expect(content).toContain('name: "Check homepage"');
    expect(content).toContain('aiAssert: "Page has a title"');
    expect(content).toContain("sleep: 1000");
  });

  test("cleans up temp file when save_as is not provided", async () => {
    const tool = api._getTool("vc_ui_accept")!;

    await tool.execute("test",{
      url: "https://example.com",
      tasks: [{ name: "Test", flow: [{ aiAssert: "works" }] }],
    });

    // Temp file should have been cleaned up
    const dir = path.join(tmpDir, ".virtucorp/acceptance");
    const files = await fs.readdir(dir);
    expect(files.filter(f => f.startsWith("_tmp_"))).toHaveLength(0);
  });

  test("quotes URL in generated YAML", async () => {
    const tool = api._getTool("vc_ui_accept")!;

    await tool.execute("test",{
      url: "https://example.com/page#section",
      tasks: [{ name: "Test", flow: [{ aiAssert: "ok" }] }],
      save_as: "url-test",
    });

    const yamlPath = path.join(tmpDir, ".virtucorp/acceptance/url-test.yaml");
    const content = await fs.readFile(yamlPath, "utf-8");
    expect(content).toContain('url: "https://example.com/page#section"');
  });

  // ── vc_ui_accept_list ──────────────────────────────────────

  test("lists saved acceptance tests", async () => {
    // Create some test files
    const dir = path.join(tmpDir, ".virtucorp/acceptance");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "test-a.yaml"), "web:\n  url: https://a.com\n");
    await fs.writeFile(path.join(dir, "test-b.yaml"), "web:\n  url: https://b.com\n");

    const tool = api._getTool("vc_ui_accept_list")!;
    const result = await tool.execute("test",{});
    expect(result).toContain("2 acceptance test(s)");
    expect(result).toContain("test-a.yaml");
    expect(result).toContain("test-b.yaml");
  });

  test("excludes temp files from listing", async () => {
    const dir = path.join(tmpDir, ".virtucorp/acceptance");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "real-test.yaml"), "web:\n  url: https://a.com\n");
    await fs.writeFile(path.join(dir, "_tmp_real-test.yaml"), "web:\n  url: https://a.com\n");

    const tool = api._getTool("vc_ui_accept_list")!;
    const result = await tool.execute("test",{});
    expect(result).toContain("1 acceptance test(s)");
    expect(result).toContain("real-test.yaml");
    expect(result).not.toContain("_tmp_");
  });

  test("returns empty message when no tests exist", async () => {
    const tool = api._getTool("vc_ui_accept_list")!;
    const result = await tool.execute("test",{});
    expect(result).toContain("No saved acceptance tests");
  });

  // ── vc_ui_accept_run ───────────────────────────────────────

  test("fails gracefully when YAML file not found", async () => {
    const tool = api._getTool("vc_ui_accept_run")!;
    const result = await tool.execute("test",{ file: "nonexistent.yaml" });
    expect(result).toContain("Failed to run nonexistent.yaml");
  });

  // ── YAML generation edge cases ─────────────────────────────

  test("escapes special characters in YAML", async () => {
    const tool = api._getTool("vc_ui_accept")!;

    await tool.execute("test",{
      url: "https://example.com",
      tasks: [
        {
          name: 'Test with "quotes"',
          flow: [{ aiAssert: 'Page shows "hello world"' }],
        },
      ],
      save_as: "escape-test",
    });

    const yamlPath = path.join(tmpDir, ".virtucorp/acceptance/escape-test.yaml");
    const content = await fs.readFile(yamlPath, "utf-8");
    expect(content).toContain('\\"quotes\\"');
    expect(content).toContain('\\"hello world\\"');
  });

  test("slugify supports non-ASCII characters", async () => {
    const tool = api._getTool("vc_ui_accept")!;

    await tool.execute("test",{
      url: "https://example.com",
      tasks: [{ name: "Test", flow: [{ aiAssert: "ok" }] }],
      save_as: "首页测试",
    });

    const dir = path.join(tmpDir, ".virtucorp/acceptance");
    const files = await fs.readdir(dir);
    const savedFiles = files.filter(f => !f.startsWith("_tmp_"));
    expect(savedFiles.length).toBe(1);
    expect(savedFiles[0]).toContain("首页测试");
  });
});
