/**
 * Session-to-role mapping with disk persistence.
 *
 * Tracks which VirtuCorp role a sub-agent session is running as.
 * Persisted to `.virtucorp/session-metadata.json` so the scheduler
 * can detect and clean up stale sessions even after gateway restarts.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { VirtuCorpRole } from "./types.js";

type SessionInfo = {
  role: VirtuCorpRole;
  createdAt: number; // Date.now()
  sessionKey: string;
};

const sessionRoles = new Map<string, SessionInfo>();
const sessionIssues = new Map<string, number>();

let persistPath: string | null = null;

const METADATA_FILE = ".virtucorp/session-metadata.json";

/**
 * Initialize persistence. Call once at plugin startup with the project directory.
 * Loads any previously saved metadata from disk.
 */
export async function initPersistence(projectDir: string): Promise<void> {
  persistPath = join(projectDir, METADATA_FILE);
  try {
    const raw = await readFile(persistPath, "utf-8");
    const entries = JSON.parse(raw) as Array<SessionInfo>;
    for (const entry of entries) {
      sessionRoles.set(entry.sessionKey, entry);
    }
  } catch {
    // No saved metadata — start fresh
  }
}

async function save(): Promise<void> {
  if (!persistPath) return;
  try {
    const dir = persistPath.replace(/\/[^/]+$/, "");
    await mkdir(dir, { recursive: true });
    const entries = Array.from(sessionRoles.values());
    await writeFile(persistPath, JSON.stringify(entries, null, 2), "utf-8");
  } catch {
    // Best-effort persistence — don't break the main flow
  }
}

export function setRoleMetadata(sessionKey: string, role: VirtuCorpRole): void {
  sessionRoles.set(sessionKey, { role, createdAt: Date.now(), sessionKey });
  void save();
}

export function getRoleMetadata(sessionKey: string | undefined): VirtuCorpRole | undefined {
  if (!sessionKey) return undefined;
  return sessionRoles.get(sessionKey)?.role;
}

export function clearRoleMetadata(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  sessionRoles.delete(sessionKey);
  sessionIssues.delete(sessionKey);
  void save();
}

export function setAssignedIssue(sessionKey: string, issueNumber: number): void {
  sessionIssues.set(sessionKey, issueNumber);
}

export function getAssignedIssue(sessionKey: string | undefined): number | undefined {
  if (!sessionKey) return undefined;
  return sessionIssues.get(sessionKey);
}

/**
 * Get all active sessions grouped by role, with their age in minutes.
 */
export function getActiveSessions(): Map<VirtuCorpRole, { sessionKey: string; ageMinutes: number }> {
  const result = new Map<VirtuCorpRole, { sessionKey: string; ageMinutes: number }>();
  const now = Date.now();
  for (const [, info] of sessionRoles) {
    result.set(info.role, {
      sessionKey: info.sessionKey,
      ageMinutes: Math.round((now - info.createdAt) / 60_000),
    });
  }
  return result;
}

/**
 * Find sessions older than the given threshold.
 * Returns session keys that should be cleaned up.
 */
export function getStaleSessions(maxAgeMinutes: number): Array<{ sessionKey: string; role: VirtuCorpRole; ageMinutes: number }> {
  const stale: Array<{ sessionKey: string; role: VirtuCorpRole; ageMinutes: number }> = [];
  const now = Date.now();
  for (const [sessionKey, info] of sessionRoles) {
    const ageMinutes = Math.round((now - info.createdAt) / 60_000);
    if (ageMinutes > maxAgeMinutes) {
      stale.push({ sessionKey, role: info.role, ageMinutes });
    }
  }
  return stale;
}
