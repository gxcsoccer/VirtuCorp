import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  createMockPluginApi,
  makeAgentContext,
  makeToolCallEvent,
} from "../test-helpers.js";
import { registerPermissionGuard } from "./permission-guard.js";
import { setRoleMetadata, clearRoleMetadata } from "../lib/role-metadata.js";

describe("permission-guard hook", () => {
  let api: ReturnType<typeof createMockPluginApi>;

  beforeEach(() => {
    api = createMockPluginApi();
    registerPermissionGuard(api as never);
  });

  afterEach(() => {
    clearRoleMetadata("session-dev");
    clearRoleMetadata("session-qa");
    clearRoleMetadata("session-pm");
    clearRoleMetadata("session-ops");
    clearRoleMetadata("session-ceo");
  });

  // ── vc_review_pr ──────────────────────────────────────────

  test("allows QA to call vc_review_pr", async () => {
    setRoleMetadata("session-qa", "qa");
    const event = makeToolCallEvent({ toolName: "vc_review_pr" });
    const ctx = makeAgentContext({ sessionKey: "session-qa" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toBeUndefined(); // undefined = allow
  });

  test("blocks Dev from calling vc_review_pr", async () => {
    setRoleMetadata("session-dev", "dev");
    const event = makeToolCallEvent({ toolName: "vc_review_pr" });
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    const result = await api._callHook("before_tool_call", event, ctx) as { block: boolean };
    expect(result?.block).toBe(true);
  });

  test("blocks PM from calling vc_review_pr", async () => {
    setRoleMetadata("session-pm", "pm");
    const event = makeToolCallEvent({ toolName: "vc_review_pr" });
    const ctx = makeAgentContext({ sessionKey: "session-pm" });
    const result = await api._callHook("before_tool_call", event, ctx) as { block: boolean };
    expect(result?.block).toBe(true);
  });

  // ── vc_merge_pr ───────────────────────────────────────────

  test("allows QA to call vc_merge_pr", async () => {
    setRoleMetadata("session-qa", "qa");
    const event = makeToolCallEvent({ toolName: "vc_merge_pr" });
    const ctx = makeAgentContext({ sessionKey: "session-qa" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toBeUndefined();
  });

  test("blocks Dev from calling vc_merge_pr", async () => {
    setRoleMetadata("session-dev", "dev");
    const event = makeToolCallEvent({ toolName: "vc_merge_pr" });
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    const result = await api._callHook("before_tool_call", event, ctx) as { block: boolean };
    expect(result?.block).toBe(true);
  });

  // ── CEO (no role metadata) ────────────────────────────────

  test("allows CEO (no role metadata) to use any vc_ tool", async () => {
    // CEO session has no role metadata set
    const event = makeToolCallEvent({ toolName: "vc_merge_pr" });
    const ctx = makeAgentContext({ sessionKey: "session-ceo" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toBeUndefined();
  });

  // ── Non-vc tools ──────────────────────────────────────────

  test("ignores non-vc tools", async () => {
    setRoleMetadata("session-dev", "dev");
    const event = makeToolCallEvent({ toolName: "execute_command" });
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toBeUndefined();
  });

  // ── Shell command interception ────────────────────────────

  test("blocks Dev from running gh pr merge via shell", async () => {
    setRoleMetadata("session-dev", "dev");
    const event = makeToolCallEvent({
      toolName: "execute_command",
      params: { command: "gh pr merge 5 --squash" },
    });
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    const result = await api._callHook("before_tool_call", event, ctx) as { block: boolean };
    expect(result?.block).toBe(true);
  });

  test("blocks Dev from running gh pr review --approve via shell", async () => {
    setRoleMetadata("session-dev", "dev");
    const event = makeToolCallEvent({
      toolName: "bash",
      params: { command: "gh pr review 3 --approve" },
    });
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    const result = await api._callHook("before_tool_call", event, ctx) as { block: boolean };
    expect(result?.block).toBe(true);
  });

  test("allows QA to run gh pr merge via shell", async () => {
    setRoleMetadata("session-qa", "qa");
    const event = makeToolCallEvent({
      toolName: "execute_command",
      params: { command: "gh pr merge 5 --squash" },
    });
    const ctx = makeAgentContext({ sessionKey: "session-qa" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toBeUndefined();
  });

  // ── Constitutional guard (protected files) ─────────────────

  test("blocks Dev from editing permission-guard.ts", async () => {
    setRoleMetadata("session-dev", "dev");
    const event = makeToolCallEvent({
      toolName: "edit",
      params: { file_path: "/workspace/VirtuCorp/extensions/virtucorp/hooks/permission-guard.ts" },
    });
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    const result = await api._callHook("before_tool_call", event, ctx) as { block: boolean; blockReason: string };
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("Constitutional guard");
  });

  test("blocks QA from writing to permission-guard.test.ts", async () => {
    setRoleMetadata("session-qa", "qa");
    const event = makeToolCallEvent({
      toolName: "write",
      params: { file_path: "/workspace/VirtuCorp/hooks/permission-guard.test.ts" },
    });
    const ctx = makeAgentContext({ sessionKey: "session-qa" });
    const result = await api._callHook("before_tool_call", event, ctx) as { block: boolean };
    expect(result?.block).toBe(true);
  });

  test("allows Dev to edit non-protected files", async () => {
    setRoleMetadata("session-dev", "dev");
    const event = makeToolCallEvent({
      toolName: "edit",
      params: { file_path: "/workspace/VirtuCorp/extensions/virtucorp/config.ts" },
    });
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toBeUndefined();
  });

  // ── Vercel deployment interception ─────────────────────────

  test("blocks Dev from running vercel deploy via shell", async () => {
    setRoleMetadata("session-dev", "dev");
    const event = makeToolCallEvent({
      toolName: "bash",
      params: { command: "vercel --prod" },
    });
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    const result = await api._callHook("before_tool_call", event, ctx) as { block: boolean };
    expect(result?.block).toBe(true);
  });

  test("allows Ops to run vercel deploy via shell", async () => {
    setRoleMetadata("session-ops", "ops");
    const event = makeToolCallEvent({
      toolName: "execute_command",
      params: { command: "vercel --prod" },
    });
    const ctx = makeAgentContext({ sessionKey: "session-ops" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toBeUndefined();
  });

  // ── vc_ui_accept ────────────────────────────────────────────

  test("allows QA to call vc_ui_accept", async () => {
    setRoleMetadata("session-qa", "qa");
    const event = makeToolCallEvent({ toolName: "vc_ui_accept" });
    const ctx = makeAgentContext({ sessionKey: "session-qa" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toBeUndefined();
  });

  test("allows PM to call vc_ui_accept", async () => {
    setRoleMetadata("session-pm", "pm");
    const event = makeToolCallEvent({ toolName: "vc_ui_accept" });
    const ctx = makeAgentContext({ sessionKey: "session-pm" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toBeUndefined();
  });

  test("blocks Dev from calling vc_ui_accept", async () => {
    setRoleMetadata("session-dev", "dev");
    const event = makeToolCallEvent({ toolName: "vc_ui_accept" });
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    const result = await api._callHook("before_tool_call", event, ctx) as { block: boolean };
    expect(result?.block).toBe(true);
  });

  test("blocks Ops from calling vc_ui_accept_run", async () => {
    setRoleMetadata("session-ops", "ops");
    const event = makeToolCallEvent({ toolName: "vc_ui_accept_run" });
    const ctx = makeAgentContext({ sessionKey: "session-ops" });
    const result = await api._callHook("before_tool_call", event, ctx) as { block: boolean };
    expect(result?.block).toBe(true);
  });

  // ── General shell commands ──────────────────────────────────

  test("allows Dev to run non-restricted shell commands", async () => {
    setRoleMetadata("session-dev", "dev");
    const event = makeToolCallEvent({
      toolName: "execute_command",
      params: { command: "gh pr list --json number,title" },
    });
    const ctx = makeAgentContext({ sessionKey: "session-dev" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toBeUndefined();
  });

  // ── CEO code access guard ──────────────────────────────────

  test("blocks CEO from reading source code files", async () => {
    const event = makeToolCallEvent({
      toolName: "read",
      params: { file_path: "/Users/lang/workspace/AlphaArena/src/client/pages/HomePage.tsx" },
    });
    const ctx = makeAgentContext({ sessionKey: "agent:virtucorp-ceo:main" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toEqual(expect.objectContaining({ block: true }));
    expect((result as { blockReason: string }).blockReason).toContain("CEO cannot read or modify source code");
  });

  test("blocks CEO from editing source code files", async () => {
    const event = makeToolCallEvent({
      toolName: "edit",
      params: { file_path: "/path/to/project/src/App.tsx" },
    });
    const ctx = makeAgentContext({ sessionKey: "agent:virtucorp-ceo:feishu:group:abc" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toEqual(expect.objectContaining({ block: true }));
  });

  test("allows CEO to read .virtucorp files", async () => {
    const event = makeToolCallEvent({
      toolName: "read",
      params: { file_path: "/path/to/project/.virtucorp/sprint.json" },
    });
    const ctx = makeAgentContext({ sessionKey: "agent:virtucorp-ceo:main" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toBeUndefined();
  });

  test("allows CEO to read package.json", async () => {
    const event = makeToolCallEvent({
      toolName: "read",
      params: { file_path: "/path/to/project/package.json" },
    });
    const ctx = makeAgentContext({ sessionKey: "agent:virtucorp-ceo:main" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toBeUndefined();
  });

  test("blocks CEO from running npm test", async () => {
    const event = makeToolCallEvent({
      toolName: "bash",
      params: { command: "npm test" },
    });
    const ctx = makeAgentContext({ sessionKey: "agent:virtucorp-ceo:main" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toEqual(expect.objectContaining({ block: true }));
    expect((result as { blockReason: string }).blockReason).toContain("CEO cannot run build/test/deploy");
  });

  test("allows CEO to run gh commands", async () => {
    const event = makeToolCallEvent({
      toolName: "bash",
      params: { command: "gh issue list --repo gxcsoccer/AlphaArena" },
    });
    const ctx = makeAgentContext({ sessionKey: "agent:virtucorp-ceo:main" });
    const result = await api._callHook("before_tool_call", event, ctx);
    expect(result).toBeUndefined();
  });
});
