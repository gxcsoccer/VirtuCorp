/**
 * Team knowledge base tools.
 *
 * All agents can save and search knowledge. Knowledge is stored as
 * Markdown files in the project repo under `.virtucorp/knowledge/`,
 * organized by category. This makes knowledge:
 * - Version-controlled (git history)
 * - Searchable (grep/gh search)
 * - Shared across all agent sessions
 * - Visible to the investor
 *
 * Categories:
 * - decisions/   — Architecture decisions, tech choices, trade-offs
 * - patterns/    — Code patterns, conventions, gotchas discovered
 * - research/    — External API docs, library evaluations, benchmarks
 * - runbook/     — How-to guides, troubleshooting steps
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const KNOWLEDGE_DIR = ".virtucorp/knowledge";
const CATEGORIES = ["decisions", "patterns", "research", "runbook"] as const;
type KnowledgeCategory = (typeof CATEGORIES)[number];

export function registerKnowledgeTools(api: OpenClawPluginApi, projectDir: string) {
  // ── Save knowledge ────────────────────────────────────────

  api.registerTool(() => ({
    name: "vc_save_knowledge",
    description:
      "Save a piece of knowledge to the team knowledge base. " +
      "Use this to preserve architectural decisions, discovered patterns, " +
      "research findings, or troubleshooting steps for future agents. " +
      "Knowledge is stored as Markdown files in .virtucorp/knowledge/.",
    parameters: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          enum: CATEGORIES,
          description:
            "Category: decisions (arch decisions), patterns (code patterns), " +
            "research (external findings), runbook (how-to guides)",
        },
        title: {
          type: "string",
          description: "Short title used as filename (e.g. 'order-matching-algorithm')",
        },
        content: {
          type: "string",
          description: "Knowledge content in Markdown",
        },
      },
      required: ["category", "title", "content"],
    },
    handler: async (args: Record<string, unknown>) => {
      const category = args.category as KnowledgeCategory;
      const title = args.title as string;
      const content = args.content as string;

      // Sanitize title for use as filename
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

      const dir = join(projectDir, KNOWLEDGE_DIR, category);
      await mkdir(dir, { recursive: true });

      const filePath = join(dir, `${slug}.md`);
      const header = `# ${title}\n\n_Saved: ${new Date().toISOString().split("T")[0]}_\n\n`;
      await writeFile(filePath, header + content, "utf-8");

      return `Knowledge saved to ${KNOWLEDGE_DIR}/${category}/${slug}.md`;
    },
  }));

  // ── Search knowledge ──────────────────────────────────────

  api.registerTool(() => ({
    name: "vc_search_knowledge",
    description:
      "Search the team knowledge base by keyword. " +
      "Returns matching excerpts from knowledge files. " +
      "Use this before starting work to check for existing decisions, patterns, or research.",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search keyword or phrase",
        },
        category: {
          type: "string",
          enum: [...CATEGORIES, "all"],
          description: "Category to search in, or 'all'. Default: all",
        },
      },
      required: ["query"],
    },
    handler: async (args: Record<string, unknown>) => {
      const query = args.query as string;
      const category = (args.category as string) ?? "all";

      const searchDir =
        category === "all"
          ? join(projectDir, KNOWLEDGE_DIR)
          : join(projectDir, KNOWLEDGE_DIR, category);

      try {
        const { stdout } = await execFileAsync(
          "grep",
          ["-r", "-i", "-l", "--include=*.md", query, searchDir],
          { timeout: 10_000 },
        );

        const files = stdout.trim().split("\n").filter(Boolean);
        if (files.length === 0) {
          return "No knowledge found matching your query.";
        }

        // Read matching files and extract relevant sections
        const results: string[] = [];
        for (const file of files.slice(0, 5)) {
          const content = await readFile(file, "utf-8");
          const relativePath = file.replace(projectDir + "/", "");
          results.push(`## ${relativePath}\n\n${content.slice(0, 1000)}`);
        }

        return results.join("\n\n---\n\n");
      } catch {
        return "No knowledge found matching your query.";
      }
    },
  }));

  // ── List knowledge ────────────────────────────────────────

  api.registerTool(() => ({
    name: "vc_list_knowledge",
    description:
      "List all knowledge entries, optionally filtered by category. " +
      "Use this to see what the team has documented.",
    parameters: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          enum: [...CATEGORIES, "all"],
          description: "Category to list, or 'all'. Default: all",
        },
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const category = (args.category as string) ?? "all";
      const results: string[] = [];

      const cats = category === "all" ? [...CATEGORIES] : [category as KnowledgeCategory];

      for (const cat of cats) {
        const dir = join(projectDir, KNOWLEDGE_DIR, cat);
        try {
          const files = await readdir(dir);
          const mdFiles = files.filter(f => f.endsWith(".md"));
          if (mdFiles.length > 0) {
            results.push(`### ${cat}/\n${mdFiles.map(f => `- ${f}`).join("\n")}`);
          }
        } catch {
          // Directory doesn't exist yet — that's fine
        }
      }

      return results.length > 0
        ? results.join("\n\n")
        : "Knowledge base is empty. Use vc_save_knowledge to add entries.";
    },
  }));
}
