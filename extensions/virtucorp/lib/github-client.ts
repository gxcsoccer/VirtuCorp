/**
 * Thin helper for running `gh` CLI with the correct repo context.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export async function gh(
  args: string[],
  config: GitHubConfig,
): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    env: { ...process.env, GH_REPO: `${config.owner}/${config.repo}` },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
  return stdout.trim();
}
