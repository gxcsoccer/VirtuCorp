import fs from "node:fs/promises";
import path from "node:path";
import { describe, test, expect, beforeAll } from "vitest";

const CEO_PROMPT_PATH = path.join(__dirname, "ceo.md");

describe("CEO role prompt – heartbeat rules", () => {
  let prompt: string;

  beforeAll(async () => {
    prompt = await fs.readFile(CEO_PROMPT_PATH, "utf-8");
  });

  test("loads CEO prompt", () => {
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("provides Template A for nothing-to-do case with HEARTBEAT_OK as sole output", () => {
    expect(prompt).toContain("Template A");
    expect(prompt).toMatch(/HEARTBEAT_OK.*NOTHING else/s);
  });

  test("provides Template B for action case with tool call first", () => {
    expect(prompt).toContain("Template B");
    expect(prompt).toMatch(/Taking action/);
  });

  test("explicitly forbids describing GitHub state in output", () => {
    // Must list the forbidden pattern of narrating digest contents
    expect(prompt).toMatch(/NEVER describe what you see/);
  });

  test("explicitly forbids citing own rules in output", () => {
    expect(prompt).toMatch(/NEVER cite your own rules/);
  });

  test("explicitly forbids text before or after HEARTBEAT_OK", () => {
    expect(prompt).toMatch(/HEARTBEAT_OK.*preceded or followed by ANY other text/s);
  });

  test("explicitly forbids adding caveats after deciding nothing is actionable", () => {
    expect(prompt).toMatch(/NEVER add caveats/);
  });
});
