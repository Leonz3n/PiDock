/**
 * Agent tool contract for the task-scoped pi session ([PiDock 02m] #5).
 *
 * The model context owns the pi `AgentSession`, but it runs in a
 * `node:worker_threads` worker whose environment is an allowlist and whose job
 * is the model request only. Tools therefore exist in exactly two halves:
 *
 * - this module (no `node:` import) names the tools, their argument schemas and
 *   the task-scoped system prompt, and turns a `call` function into pi
 *   `ToolDefinition`s. The worker uses it to declare tools to its AgentSession;
 * - `sdk-agent-tool-broker.ts` (Host side) is the only code that executes
 *   anything, after the existing permission gate and the task write lock.
 *
 * Tool names are the gated names of `main/pi-session.ts` (`fs.read`,
 * `fs.write`, `exec.run` plus the read-only `fs.search`), so every invocation
 * is decided by the one existing gate instead of a second opinion here.
 *
 * The Host never trusts the worker's declared schema: `sdk-agent-tool-broker.ts`
 * re-validates every argument strictly. The schema below exists so the model can
 * call the tool at all.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type SdkAgentToolName = "fs.read" | "fs.search" | "fs.write" | "exec.run";

/** The gate kind each tool is decided as (`PiToolKind` semantics). */
export type SdkAgentToolKind = "read" | "write" | "command";

export interface SdkAgentToolSpec {
  name: SdkAgentToolName;
  kind: SdkAgentToolKind;
  /** One-line snippet for the prompt. */
  summary: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const SDK_AGENT_TOOL_SPECS: readonly SdkAgentToolSpec[] = [
  {
    name: "fs.read",
    kind: "read",
    summary: "Read a text file inside the task folder",
    description:
      "Read the contents of a text file. `path` is relative to the task folder (absolute paths are only accepted inside the task worktrees). Output is truncated; use `offset`/`limit` (1-indexed lines) to continue.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "Path to the file to read" },
        offset: { type: "integer", minimum: 1, description: "First line to return (1-indexed)" },
        limit: { type: "integer", minimum: 1, description: "Maximum number of lines to return" },
      },
    },
  },
  {
    name: "fs.search",
    kind: "read",
    summary: "List or search files inside the task folder",
    description:
      "With `path` only, list the directory entries (directories end with `/`). With `pattern`, search files under `path` line by line and return `path:line: text` matches. `path` is relative to the task folder. `.git` is never searched; results are bounded.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "File or directory to list/search" },
        pattern: { type: "string", description: "Regular expression; omit to list the directory" },
      },
    },
  },
  {
    name: "fs.write",
    kind: "write",
    summary: "Create or overwrite a file inside a task worktree",
    description:
      "Write `content` to `path`, creating parent directories. `path` must stay inside one of this task's worktrees; the original checkout is never written.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path", "content"],
      properties: {
        path: { type: "string", description: "Path to the file to write" },
        content: { type: "string", description: "Full new file content" },
      },
    },
  },
  {
    name: "exec.run",
    kind: "command",
    summary: "Run a shell command in a task worktree",
    description:
      "Run `command` with `/bin/sh -c`, in `cwd` (default: the task's first worktree). `cwd` must stay inside a task worktree, arguments naming paths outside the task worktrees are refused, output and runtime are bounded.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: { type: "string", description: "Shell command to run" },
        cwd: { type: "string", description: "Working directory inside a task worktree" },
      },
    },
  },
];

export const SDK_AGENT_TOOL_NAMES: readonly SdkAgentToolName[] = SDK_AGENT_TOOL_SPECS.map((spec) => spec.name);

export function sdkAgentToolSpec(name: string): SdkAgentToolSpec | undefined {
  return SDK_AGENT_TOOL_SPECS.find((spec) => spec.name === name);
}

/** One tool invocation: the Host broker re-validates `args` from scratch. */
export interface SdkAgentToolRequest {
  tool: SdkAgentToolName;
  args: unknown;
}

/** What the model reads: a result, or a named refusal it must work around. */
export interface SdkAgentToolOutcome {
  outcome: "ok" | "refused";
  text: string;
  /** Machine-readable refusal code (`tool-refused:<reason>`), absent when ok. */
  code?: string;
}

/**
 * The one bridge the worker and the Host share. `sessionId` travels with the
 * request because one worker context serves every session of the task; the Host
 * refuses a session it does not know.
 */
export type SdkAgentToolCaller = (sessionId: string, request: SdkAgentToolRequest) => Promise<SdkAgentToolOutcome>;

/**
 * Build the pi tool definitions one AgentSession declares. `sessionId` is the
 * session whose JSONL this AgentSession owns: the kernel builds its tools per
 * session, so the request always names the session the gate must decide for.
 */
export function buildSdkAgentToolDefinitions(sessionId: string, call: SdkAgentToolCaller): ToolDefinition[] {
  return SDK_AGENT_TOOL_SPECS.map(
    (spec) =>
      ({
        name: spec.name,
        label: spec.name,
        description: spec.description,
        promptSnippet: spec.summary,
        parameters: spec.parameters as ToolDefinition["parameters"],
        // A mutating tool must not interleave with another one; reads may run
        // alongside each other (the agent default is parallel).
        executionMode: spec.kind === "read" ? "parallel" : "sequential",
        async execute(_toolCallId: string, params: unknown) {
          const outcome = await call(sessionId, { tool: spec.name, args: params });
          return { content: [{ type: "text" as const, text: outcome.text }], details: undefined };
        },
      }) as unknown as ToolDefinition,
  );
}

/**
 * The task-scoped system prompt. It replaces the pi default prompt (the SDK
 * skips its own tools/rules sections when a custom prompt is supplied), so it
 * states the tool set and the confinement rule the Host enforces.
 */
export function sdkAgentSystemPrompt(input: { taskDir: string; worktrees: readonly string[] }): string {
  const worktrees = input.worktrees.length > 0 ? input.worktrees.map((path) => `- ${path}`).join("\n") : "- (this task has no repository worktree yet)";
  return [
    "You are the PiDock task agent. You work inside exactly one task folder and its repository worktrees.",
    `Task folder: ${input.taskDir}`,
    "Worktrees you may write to:",
    worktrees,
    "You may read files anywhere inside the task folder. Every path and command working directory must stay inside this task; a path that escapes (an absolute path outside, `..`, a symlink pointing outside, an original checkout, another task or an application-private path) is refused before it takes effect.",
    "Available tools:",
    "- fs.read: read a file (args: path, optional offset/limit)",
    "- fs.search: list a directory or search files by pattern (args: path, optional pattern)",
    "- fs.write: create or overwrite a file in a worktree (args: path, content)",
    "- exec.run: run a shell command in a worktree (args: command, optional cwd)",
    "Every write and command is subject to the task's permission gate and write lock: a refusal comes back as a tool result with a reason, so adapt instead of retrying the same call.",
  ].join("\n");
}
