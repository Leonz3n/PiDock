/**
 * A session is only unique inside its task, so every map keyed by session
 * (drafts, live messages, run records) uses this shape. Kept in one place so
 * the adapters, stores and pages cannot drift apart.
 */
export type SessionKey = `${string}:${string}`;

export function sessionKeyOf(taskId: string, sessionId: string): SessionKey {
  return `${taskId}:${sessionId}`;
}
