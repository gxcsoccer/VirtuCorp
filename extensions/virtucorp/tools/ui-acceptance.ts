/**
 * UI Acceptance Testing tool powered by MidsceneJS.
 *
 * Allows QA and PM to run visual UI acceptance tests against a deployed
 * application using natural-language assertions in YAML format.
 *
 * MidsceneJS uses vision-based AI to analyze screenshots and verify UI
 * conditions — no selectors or DOM inspection needed.
 *
 * @see https://midscenejs.com/zh/automate-with-scripts-in-yaml.html
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

const execFileAsync = promisify(execFile);

const ACCEPTANCE_DIR = ".virtucorp/acceptance";

export function registerUIAcceptanceTools(api: OpenClawPluginApi, projectDir: string) {
  // ── vc_ui_accept: run UI acceptance tests ──────────────────

  api.registerTool(() => ({
    name: "vc_ui_accept",
    description:
      "Run a UI acceptance test against a deployed URL using MidsceneJS. " +
      "Write test steps and assertions in natural language. " +
      "Only QA and PM roles can use this tool.",
    parameters: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to test (e.g. https://alpha-arena.vercel.app)",
        },
        tasks: {
          type: "array",
          description:
            "Array of test tasks. Each task has a name and a flow of steps. " +
            "Steps can be: ai/aiAct (interact), aiAssert (verify), aiQuery (extract data), " +
            "aiWaitFor (wait for condition), sleep (wait ms).",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Task name" },
              flow: {
                type: "array",
                description:
                  "Steps in natural language. Each step is an object with one key: " +
                  'ai, aiAssert, aiWaitFor, aiQuery, aiTap, aiInput, sleep. ' +
                  'Example: {"aiAssert": "页面显示了股票列表"}, {"ai": "点击第一只股票"}',
                items: { type: "object" },
              },
            },
            required: ["name", "flow"],
          },
        },
        save_as: {
          type: "string",
          description:
            "Optional: save this test as a reusable YAML file under .virtucorp/acceptance/<name>.yaml " +
            "for future sprint acceptance runs.",
        },
      },
      required: ["url", "tasks"],
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const url = args.url as string;
      const tasks = args.tasks as Array<{ name: string; flow: Array<Record<string, unknown>> }>;
      const saveAs = args.save_as as string | undefined;

      // Build the YAML content
      const yaml = buildYaml(url, tasks);

      // Ensure acceptance directory exists
      const acceptDir = join(projectDir, ACCEPTANCE_DIR);
      await mkdir(acceptDir, { recursive: true });

      // Write YAML — named file if save_as, otherwise temp file
      const fileName = saveAs
        ? `${slugify(saveAs)}.yaml`
        : `_tmp_acceptance-${Date.now()}.yaml`;
      const yamlPath = join(acceptDir, fileName);
      await writeFile(yamlPath, yaml, "utf-8");

      const result = await runMidscene(yamlPath, projectDir);

      // Clean up temp files (not saved ones)
      if (!saveAs) {
        await unlink(yamlPath).catch(() => {});
      }

      return result;
    },
  }));

  // ── vc_ui_accept_run: run a saved acceptance YAML ──────────

  api.registerTool(() => ({
    name: "vc_ui_accept_run",
    description:
      "Run a previously saved UI acceptance test YAML file from .virtucorp/acceptance/. " +
      "Only QA and PM roles can use this tool.",
    parameters: {
      type: "object" as const,
      properties: {
        file: {
          type: "string",
          description:
            "Name of the YAML file to run (e.g. 'homepage.yaml'). " +
            "Files are located in .virtucorp/acceptance/",
        },
        url_override: {
          type: "string",
          description:
            "Optional: override the URL in the YAML file (useful for testing preview deploys)",
        },
      },
      required: ["file"],
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const file = args.file as string;
      const urlOverride = args.url_override as string | undefined;
      const yamlPath = join(projectDir, ACCEPTANCE_DIR, file);

      try {
        let yamlContent = await readFile(yamlPath, "utf-8");

        // If URL override, replace the url field and write to a temp file
        if (urlOverride) {
          yamlContent = yamlContent.replace(
            /^(\s*url:\s*).+$/m,
            `$1"${urlOverride}"`,
          );
          const tmpPath = join(projectDir, ACCEPTANCE_DIR, `_tmp_${file}`);
          await writeFile(tmpPath, yamlContent, "utf-8");

          const result = await runMidscene(tmpPath, projectDir);
          await unlink(tmpPath).catch(() => {});
          return result;
        }

        return await runMidscene(yamlPath, projectDir);
      } catch (err) {
        const error = err as { message?: string };
        return `❌ Failed to run ${file}: ${error.message ?? "Unknown error"}`;
      }
    },
  }));

  // ── vc_ui_accept_list: list saved acceptance tests ─────────

  api.registerTool(() => ({
    name: "vc_ui_accept_list",
    description:
      "List all saved UI acceptance test YAML files in .virtucorp/acceptance/.",
    parameters: {
      type: "object" as const,
      properties: {},
    },
    execute: async (_toolCallId: string, _args: Record<string, unknown>) => {
      const acceptDir = join(projectDir, ACCEPTANCE_DIR);
      try {
        const entries = await readdir(acceptDir);
        const files = entries.filter(f => f.endsWith(".yaml") && !f.startsWith("_tmp_"));
        if (files.length === 0) {
          return "No saved acceptance tests found in .virtucorp/acceptance/";
        }
        return [
          `Found ${files.length} acceptance test(s):`,
          "",
          ...files.map(f => `  - ${f}`),
        ].join("\n");
      } catch {
        return "No saved acceptance tests found in .virtucorp/acceptance/";
      }
    },
  }));
}

// ── Helpers ────────────────────────────────────────────────────

async function runMidscene(yamlPath: string, cwd: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "npx",
      ["midscene", yamlPath],
      {
        cwd,
        env: { ...process.env },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300_000,
      },
    );

    // If execFileAsync didn't throw, exit code is 0 — tests passed
    const output = [stdout, stderr].filter(Boolean).join("\n");
    return [
      "✅ UI acceptance tests PASSED",
      "",
      `Test file: ${yamlPath}`,
      "",
      output,
    ].join("\n");
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return [
      "❌ UI acceptance tests FAILED",
      "",
      `Test file: ${yamlPath}`,
      "",
      error.stdout ?? "",
      error.stderr ?? error.message ?? "Unknown error",
    ].join("\n");
  }
}

function buildYaml(
  url: string,
  tasks: Array<{ name: string; flow: Array<Record<string, unknown>> }>,
): string {
  const lines: string[] = [
    "web:",
    `  url: "${escapeYaml(url)}"`,
    "",
    "tasks:",
  ];

  for (const task of tasks) {
    lines.push(`  - name: "${escapeYaml(task.name)}"`);
    lines.push("    flow:");
    for (const step of task.flow) {
      const [key, value] = Object.entries(step)[0];
      if (typeof value === "string") {
        lines.push(`      - ${key}: "${escapeYaml(value)}"`);
      } else if (typeof value === "number") {
        lines.push(`      - ${key}: ${value}`);
      } else {
        // Complex object (e.g. aiInput with value param)
        lines.push(`      - ${key}:`);
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          lines.push(`          ${k}: "${escapeYaml(String(v))}"`);
        }
      }
    }
  }

  return lines.join("\n") + "\n";
}

function escapeYaml(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    // Keep Unicode word chars (letters, digits, CJK, etc.)
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    // Fallback if result is empty (e.g. only special chars)
    || `test-${Date.now()}`;
}
