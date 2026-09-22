/**
 * Renderer view of the sandboxed preload bridge (`window.pidock`).
 *
 * The renderer is sandboxed (sandbox:true, contextIsolation:true,
 * nodeIntegration:false) and must never import Node or Electron. All Host
 * traffic goes through the `shell/*` invoke channels main allowlists; task
 * routing ids stay sender-bound in main, so the page can name its own task
 * but never another workspace. Falls back to `null` outside the shell
 * (Vite dev, tests) so pages degrade to the in-memory adapter explicitly.
 */

export interface ShellTaskOpResult {
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export interface PidockBridge {
  getSecurityState?: () => { sandboxed: boolean; contextIsolated: boolean };
  getVersions?: () => Promise<unknown>;
  hostPing?: (workspaceId?: string) => Promise<unknown>;
  taskOp?: (taskId: string, op: string, payload?: Record<string, unknown>) => Promise<ShellTaskOpResult>;
}

declare global {
  interface Window {
    pidock?: PidockBridge;
  }
}

/** `null` outside the Electron shell (Vite dev server, vitest/jsdom). */
export function shellBridge(): PidockBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.pidock;
  if (!bridge || typeof bridge !== "object") return null;
  return bridge;
}

/** True when the page runs inside the sandboxed shell view. */
export function isShellConnected(): boolean {
  return shellBridge() !== null;
}

/**
 * Task-scoped op through main into the per-workspace Host. Rejects outside
 * the shell so dev/test callers must opt into the in-memory adapter instead
 * of silently assuming a Host round-trip.
 */
export async function shellTaskOp(
  taskId: string,
  op: "task/provision" | "task/sendMessage" | "task/cancel" | "task/approve" | "task/reject",
  payload: Record<string, unknown> = {},
): Promise<ShellTaskOpResult> {
  const bridge = shellBridge();
  if (!bridge?.taskOp) throw new Error("当前不在桌面壳内，任务操作走内存模拟数据");
  return bridge.taskOp(taskId, op, payload);
}
