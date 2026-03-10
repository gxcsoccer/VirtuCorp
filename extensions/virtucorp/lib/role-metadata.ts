/**
 * Session-to-role mapping.
 *
 * Tracks which VirtuCorp role a sub-agent session is running as.
 * This is an in-memory store — sessions are short-lived, so persistence is unnecessary.
 */

import type { VirtuCorpRole } from "./types.js";

const sessionRoles = new Map<string, VirtuCorpRole>();
const sessionIssues = new Map<string, number>();

export function setRoleMetadata(sessionKey: string, role: VirtuCorpRole): void {
  sessionRoles.set(sessionKey, role);
}

export function getRoleMetadata(sessionKey: string | undefined): VirtuCorpRole | undefined {
  if (!sessionKey) return undefined;
  return sessionRoles.get(sessionKey);
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
