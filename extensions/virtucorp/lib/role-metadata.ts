/**
 * Session-to-role mapping.
 *
 * Tracks which VirtuCorp role a sub-agent session is running as.
 * This is an in-memory store — sessions are short-lived, so persistence is unnecessary.
 */

import type { VirtuCorpRole } from "./types.js";

type SessionInfo = {
  role: VirtuCorpRole;
  createdAt: number; // Date.now()
  sessionKey: string;
};

const sessionRoles = new Map<string, SessionInfo>();
const sessionIssues = new Map<string, number>();

export function setRoleMetadata(sessionKey: string, role: VirtuCorpRole): void {
  sessionRoles.set(sessionKey, { role, createdAt: Date.now(), sessionKey });
}

export function getRoleMetadata(sessionKey: string | undefined): VirtuCorpRole | undefined {
  if (!sessionKey) return undefined;
  return sessionRoles.get(sessionKey)?.role;
}

export function clearRoleMetadata(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  sessionRoles.delete(sessionKey);
  sessionIssues.delete(sessionKey);
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
