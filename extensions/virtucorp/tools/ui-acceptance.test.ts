import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockPluginApi } from "../test-helpers.js";
import { registerUIAcceptanceTools } from "./ui-acceptance.js";
import type { AuthConfig } from "../lib/types.js";

// Mock execFileAsync to avoid actually running midscene
vi.mock("node:child_process", () => ({
  execFile: vi.fn((...args: unknown[]) => {
    // Simulate midscene not being installed
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      callback(new Error("midscene not found"), "", "");
    }
    return undefined;
  }),
}));

describe("ui-acceptance tools", () => {
  let api: ReturnType<typeof createMockPluginApi>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-ui-accept-test-"));
    api = createMockPluginApi();
    registerUIAcceptanceTools(api as never, tmpDir, undefined);
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

// ── Auth configuration tests ─────────────────────────────────

describe("ui-acceptance tools with auth", () => {
  let api: ReturnType<typeof createMockPluginApi>;
  let tmpDir: string;
  let authConfig: AuthConfig;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-ui-accept-auth-test-"));
    api = createMockPluginApi();
    authConfig = {
      loginUrl: "https://example.com/login",
      steps: [
        { ai: "输入邮箱 test@example.com 到邮箱输入框" },
        { ai: "输入密码 test-password 到密码输入框" },
        { ai: "点击登录按钮" },
        { aiWaitFor: "登录成功，页面跳转到首页" },
      ],
    };
    registerUIAcceptanceTools(api as never, tmpDir, authConfig);
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns error when requiresAuth is true but auth is not configured", async () => {
    // Create a new API without auth config
    const apiNoAuth = createMockPluginApi();
    registerUIAcceptanceTools(apiNoAuth as never, tmpDir, undefined);
    const tool = apiNoAuth._getTool("vc_ui_accept")!;

    const result = await tool.execute("test",{
      url: "https://example.com",
      tasks: [
        {
          name: "Protected page test",
          requiresAuth: true,
          flow: [{ aiAssert: "Page shows user profile" }],
        },
      ],
    });

    expect(result).toContain("Authentication required but not configured");
    expect(result).toContain("Protected page test");
    expect(result).toContain("auth");
  });

  test("prepends auth steps when requiresAuth is true", async () => {
    const tool = api._getTool("vc_ui_accept")!;

    await tool.execute("test",{
      url: "https://example.com",
      tasks: [
        {
          name: "Protected page test",
          requiresAuth: true,
          flow: [{ aiAssert: "Page shows user profile" }],
        },
      ],
      save_as: "auth-test",
    });

    const yamlPath = path.join(tmpDir, ".virtucorp/acceptance/auth-test.yaml");
    const content = await fs.readFile(yamlPath, "utf-8");

    // Should include login URL navigation
    expect(content).toContain("导航到 https://example.com/login");

    // Should include all auth steps
    expect(content).toContain("输入邮箱 test@example.com");
    expect(content).toContain("输入密码 test-password");
    expect(content).toContain("点击登录按钮");
    expect(content).toContain("登录成功");

    // Should include the actual test assertion
    expect(content).toContain("Page shows user profile");
  });

  test("auth steps are added only once for multiple tasks requiring auth", async () => {
    const tool = api._getTool("vc_ui_accept")!;

    await tool.execute("test",{
      url: "https://example.com",
      tasks: [
        {
          name: "First protected page",
          requiresAuth: true,
          flow: [{ aiAssert: "First page works" }],
        },
        {
          name: "Second protected page",
          requiresAuth: true,
          flow: [{ aiAssert: "Second page works" }],
        },
      ],
      save_as: "multi-auth-test",
    });

    const yamlPath = path.join(tmpDir, ".virtucorp/acceptance/multi-auth-test.yaml");
    const content = await fs.readFile(yamlPath, "utf-8");

    // Auth steps should appear only once (for the first task)
    const loginOccurrences = (content.match(/导航到 https:\/\/example\.com\/login/g) || []).length;
    expect(loginOccurrences).toBe(1);
  });

  test("non-auth tasks do not get auth steps", async () => {
    const tool = api._getTool("vc_ui_accept")!;

    await tool.execute("test",{
      url: "https://example.com",
      tasks: [
        {
          name: "Public page test",
          flow: [{ aiAssert: "Page shows public content" }],
        },
      ],
      save_as: "public-test",
    });

    const yamlPath = path.join(tmpDir, ".virtucorp/acceptance/public-test.yaml");
    const content = await fs.readFile(yamlPath, "utf-8");

    // Should NOT include auth steps
    expect(content).not.toContain("登录");
    expect(content).not.toContain("密码");
    expect(content).toContain("Page shows public content");
  });

  test("works with auth but no loginUrl (uses base url)", async () => {
    const apiNoLoginUrl = createMockPluginApi();
    const authNoLoginUrl: AuthConfig = {
      steps: [
        { ai: "直接在当前页面登录" },
      ],
    };
    registerUIAcceptanceTools(apiNoLoginUrl as never, tmpDir, authNoLoginUrl);
    const tool = apiNoLoginUrl._getTool("vc_ui_accept")!;

    await tool.execute("test",{
      url: "https://example.com/dashboard",
      tasks: [
        {
          name: "Dashboard test",
          requiresAuth: true,
          flow: [{ aiAssert: "Dashboard shows data" }],
        },
      ],
      save_as: "no-login-url-test",
    });

    const yamlPath = path.join(tmpDir, ".virtucorp/acceptance/no-login-url-test.yaml");
    const content = await fs.readFile(yamlPath, "utf-8");

    // Should not have login URL navigation, but should have auth steps
    expect(content).not.toContain("导航到");
    expect(content).toContain("直接在当前页面登录");
  });
});
