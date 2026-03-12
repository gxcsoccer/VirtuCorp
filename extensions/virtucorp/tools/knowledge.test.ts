import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createMockPluginApi } from "../test-helpers.js";
import { registerKnowledgeTools } from "./knowledge.js";

describe("knowledge tools", () => {
  let api: ReturnType<typeof createMockPluginApi>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-knowledge-test-"));
    api = createMockPluginApi();
    registerKnowledgeTools(api as never, tmpDir);
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("registers three knowledge tools", () => {
    expect(api.registerTool).toHaveBeenCalledTimes(3);
    expect(api._getTool("vc_save_knowledge")).toBeDefined();
    expect(api._getTool("vc_search_knowledge")).toBeDefined();
    expect(api._getTool("vc_list_knowledge")).toBeDefined();
  });

  // ── vc_save_knowledge ─────────────────────────────────────

  test("saves knowledge to the correct path", async () => {
    const tool = api._getTool("vc_save_knowledge")!;
    const result = await tool.execute("test",{
      category: "decisions",
      title: "Use TypeScript",
      content: "We chose TypeScript for type safety.",
    });

    expect(result).toContain("decisions/use-typescript.md");

    const filePath = path.join(tmpDir, ".virtucorp/knowledge/decisions/use-typescript.md");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("# Use TypeScript");
    expect(content).toContain("We chose TypeScript for type safety.");
    expect(content).toContain("Saved:");
  });

  test("slugifies title correctly", async () => {
    const tool = api._getTool("vc_save_knowledge")!;
    await tool.execute("test",{
      category: "patterns",
      title: "Error Handling Best Practices!!!",
      content: "Always catch errors.",
    });

    const filePath = path.join(
      tmpDir,
      ".virtucorp/knowledge/patterns/error-handling-best-practices.md",
    );
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  test("overwrites existing knowledge file", async () => {
    const tool = api._getTool("vc_save_knowledge")!;
    await tool.execute("test",{
      category: "decisions",
      title: "Database Choice",
      content: "Use SQLite.",
    });
    await tool.execute("test",{
      category: "decisions",
      title: "Database Choice",
      content: "Changed to PostgreSQL.",
    });

    const filePath = path.join(tmpDir, ".virtucorp/knowledge/decisions/database-choice.md");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("Changed to PostgreSQL.");
    expect(content).not.toContain("Use SQLite.");
  });

  // ── vc_search_knowledge ───────────────────────────────────

  test("finds knowledge by keyword", async () => {
    const saveTool = api._getTool("vc_save_knowledge")!;
    await saveTool.execute("test",{
      category: "patterns",
      title: "Retry Logic",
      content: "Use exponential backoff for API calls.",
    });
    await saveTool.execute("test",{
      category: "decisions",
      title: "API Design",
      content: "Use REST with JSON.",
    });

    const searchTool = api._getTool("vc_search_knowledge")!;
    const result = await searchTool.execute("test",{ query: "exponential backoff" });
    expect(result).toContain("retry-logic.md");
    expect(result).toContain("exponential backoff");
  });

  test("returns message when no matches found", async () => {
    const tool = api._getTool("vc_search_knowledge")!;
    const result = await tool.execute("test",{ query: "nonexistent topic xyz123" });
    expect(result).toContain("No knowledge found");
  });

  test("searches within specific category", async () => {
    const saveTool = api._getTool("vc_save_knowledge")!;
    await saveTool.execute("test",{
      category: "patterns",
      title: "Test Pattern",
      content: "Always use fixtures.",
    });
    await saveTool.execute("test",{
      category: "decisions",
      title: "Test Decision",
      content: "Always use fixtures.",
    });

    const searchTool = api._getTool("vc_search_knowledge")!;
    const result = await searchTool.execute("test",{ query: "fixtures", category: "patterns" });
    expect(result).toContain("patterns");
    expect(result).not.toContain("decisions");
  });

  // ── vc_list_knowledge ─────────────────────────────────────

  test("lists knowledge entries", async () => {
    const saveTool = api._getTool("vc_save_knowledge")!;
    await saveTool.execute("test",{
      category: "decisions",
      title: "Use Vitest",
      content: "Fast test runner.",
    });
    await saveTool.execute("test",{
      category: "runbook",
      title: "Deploy Steps",
      content: "Step 1: build.",
    });

    const listTool = api._getTool("vc_list_knowledge")!;
    const result = await listTool.execute("test",{});
    expect(result).toContain("decisions/");
    expect(result).toContain("use-vitest.md");
    expect(result).toContain("runbook/");
    expect(result).toContain("deploy-steps.md");
  });

  test("lists knowledge filtered by category", async () => {
    const saveTool = api._getTool("vc_save_knowledge")!;
    await saveTool.execute("test",{ category: "decisions", title: "A", content: "a" });
    await saveTool.execute("test",{ category: "patterns", title: "B", content: "b" });

    const listTool = api._getTool("vc_list_knowledge")!;
    const result = await listTool.execute("test",{ category: "decisions" });
    expect(result).toContain("decisions/");
    expect(result).not.toContain("patterns/");
  });

  test("returns empty message when no knowledge exists", async () => {
    const listTool = api._getTool("vc_list_knowledge")!;
    const result = await listTool.execute("test",{});
    expect(result).toContain("Knowledge base is empty");
  });
});
