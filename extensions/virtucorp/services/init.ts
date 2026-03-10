/**
 * Project initialization: set up a GitHub repo for VirtuCorp.
 *
 * Creates all required labels, initializes .virtucorp/ directory,
 * and optionally creates the first Sprint milestone.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gh } from "../lib/github-client.js";
import { LABELS, type GitHubConfig } from "../lib/types.js";
import { createInitialSprintState, saveSprintState } from "./sprint-scheduler.js";

/**
 * All labels VirtuCorp needs on the GitHub repo.
 */
const REQUIRED_LABELS: Array<{ name: string; color: string; description: string }> = [
  // Status
  { name: LABELS.STATUS_READY, color: "0E8A16", description: "Ready to be picked up by Dev" },
  { name: LABELS.STATUS_IN_PROGRESS, color: "FBCA04", description: "Dev is working on this" },
  { name: LABELS.STATUS_IN_REVIEW, color: "1D76DB", description: "PR submitted, awaiting QA review" },
  { name: LABELS.STATUS_DONE, color: "6F42C1", description: "Completed and merged" },
  // Priority
  { name: LABELS.PRIORITY_P0, color: "B60205", description: "Critical — must fix immediately" },
  { name: LABELS.PRIORITY_P1, color: "D93F0B", description: "High priority" },
  { name: LABELS.PRIORITY_P2, color: "E4E669", description: "Normal priority" },
  // Type
  { name: LABELS.TYPE_FEATURE, color: "0075CA", description: "New feature" },
  { name: LABELS.TYPE_BUG, color: "D73A4A", description: "Bug fix" },
  { name: LABELS.TYPE_REFACTOR, color: "A2EEEF", description: "Code refactoring" },
  { name: LABELS.TYPE_CHORE, color: "CFD3D7", description: "Maintenance task" },
  // Agent
  { name: LABELS.AGENT_PM, color: "F9D0C4", description: "Managed by PM agent" },
  { name: LABELS.AGENT_DEV, color: "C2E0C6", description: "Assigned to Dev agent" },
  { name: LABELS.AGENT_QA, color: "BFD4F2", description: "Assigned to QA agent" },
  { name: LABELS.AGENT_OPS, color: "D4C5F9", description: "Assigned to Ops agent" },
  // Meta
  { name: LABELS.NEEDS_INVESTOR_APPROVAL, color: "FF0000", description: "Requires investor approval" },
  { name: LABELS.META_IMPROVEMENT, color: "5319E7", description: "Improvement to VirtuCorp itself" },
];

export async function initProject(
  githubConfig: GitHubConfig,
  projectDir: string,
  sprintDurationDays: number,
): Promise<string[]> {
  const log: string[] = [];

  // 1. Create labels
  log.push("Creating GitHub labels...");
  for (const label of REQUIRED_LABELS) {
    try {
      await gh(
        [
          "label", "create", label.name,
          "--color", label.color,
          "--description", label.description,
          "--force", // update if exists
        ],
        githubConfig,
      );
      log.push(`  ✓ ${label.name}`);
    } catch (err) {
      log.push(`  ✗ ${label.name}: ${err}`);
    }
  }

  // 2. Initialize .virtucorp directory
  log.push("Initializing .virtucorp/ directory...");
  const vcDir = join(projectDir, ".virtucorp");
  const knowledgeDir = join(vcDir, "knowledge");
  await mkdir(join(knowledgeDir, "decisions"), { recursive: true });
  await mkdir(join(knowledgeDir, "patterns"), { recursive: true });
  await mkdir(join(knowledgeDir, "research"), { recursive: true });
  await mkdir(join(knowledgeDir, "runbook"), { recursive: true });
  log.push("  ✓ .virtucorp/knowledge/ created");

  // 3. Create initial Sprint state
  const state = createInitialSprintState(1, sprintDurationDays);
  await saveSprintState(projectDir, state);
  log.push(`  ✓ Sprint 1 initialized (${sprintDurationDays} day${sprintDurationDays > 1 ? "s" : ""})`);

  // 4. Create .gitkeep files so empty dirs are tracked
  for (const cat of ["decisions", "patterns", "research", "runbook"]) {
    await writeFile(join(knowledgeDir, cat, ".gitkeep"), "", "utf-8");
  }

  log.push("Done! Project is ready for VirtuCorp.");
  return log;
}
