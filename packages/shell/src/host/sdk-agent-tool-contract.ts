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
 * `fs.write`, `exec.run`, the read-only `fs.search` and the [PiDock 04] #7
 * service surface `service.status`/`service.logs`/`service.start`/`service.stop`),
 * so every invocation is decided by the one existing gate instead of a second
 * opinion here.
 *
 * The Host never trusts the worker's declared schema: `sdk-agent-tool-broker.ts`
 * re-validates every argument strictly. The schema below exists so the model can
 * call the tool at all.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * [PiDock 04] (#7 box 6) the Agent's shared-template edit tool. One spelling for
 * the two lists that must agree: the gate's `PI_GATED_TOOLS` (`main/pi-session.ts`)
 * and this contract. The gate carries the name-scoped rule that this tool is
 * never written without a shown diff (see `PiSessionChannel.previewGate`), so the
 * name is exported here instead of being spelled twice.
 */
export const SERVICE_TEMPLATE_TOOL = "service.template.update";

export type SdkAgentToolName =
  | "fs.read"
  | "fs.search"
  | "fs.write"
  | "exec.run"
  | "service.status"
  | "service.logs"
  | "service.start"
  | "service.stop"
  | typeof SERVICE_TEMPLATE_TOOL;

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
      "With `path` only, list the directory entries (directories end with `/`). With `pattern`, search files under `path` line by line and return `path:line: text` matches. `path` is relative to the task folder. `.git`, `node_modules` and the Host's own `.pidock-*` state and `task.json` are never searched, however the search is rooted; results are bounded.",
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
      "Run `command` with `/bin/sh -c`, in `cwd` (default: the task's first worktree). `cwd` must stay inside a task worktree, and a command whose expansion cannot be decoded (`$`, backticks) is refused outright — even under `default`, so `echo $PWD` is refused instead of offered for approval. This is a filter, not a sandbox: only tokens that contain `/`, start with `~`, are exactly `..`, or name a `.git` path (case-insensitively, including simple quoting/backslash spellings like `.g\\it`) are examined, so a path the shell re-encodes (`printf '\\057tmp\\057x' | xargs touch`) still runs under `auto`, with no approval. Output and runtime are bounded.",
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
  // [PiDock 04] #7 box 5: the Agent's own service tools. The Agent names only a
  // `serviceId` this task really has bound; the Host resolves the program, the
  // effective configuration, the logs and the process identity itself, so a
  // call can never name a program, a path, a port or an environment value.
  {
    name: "service.status",
    kind: "read",
    summary: "Read one task-bound service's real process state",
    description:
      "Report `serviceId`'s real state as the task Host knows it. `serviceId` must be a service this task has bound; anything else is refused by name. `lifecycle` is process liveness only — dependency reachability is reported separately as a note and never turns a dead process into a running one (or the reverse).",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["serviceId"],
      properties: { serviceId: { type: "string", description: "Id of a service bound to this task" } },
    },
  },
  {
    name: "service.logs",
    kind: "read",
    summary: "Read the bounded log tail of one task-bound service",
    description:
      "Return the bounded log tail of `serviceId` (a service bound to this task). At most `limit` lines (default 40, max 100), each already truncated and redacted by the Host — private values never appear. There is no log stream: this is a bounded read of the tail.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["serviceId"],
      properties: {
        serviceId: { type: "string", description: "Id of a service bound to this task" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of trailing log lines" },
      },
    },
  },
  {
    name: "service.start",
    kind: "command",
    summary: "Start one task-bound service through the Host (gated)",
    description:
      "Ask the Host to start `serviceId`, a service this task has bound. The program, arguments, working directory, effective environment and process identity all come from the task's own resolved binding — this call names nothing else, and extra arguments are refused. The permission gate decides first: a read-only session is refused, `default` asks the user for one confirmation (rejection, cancellation or expiry performs no action), and one confirmation authorizes exactly one start or stop. An unknown or foreign `serviceId` starts nothing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["serviceId"],
      properties: { serviceId: { type: "string", description: "Id of a service bound to this task" } },
    },
  },
  {
    name: "service.stop",
    kind: "command",
    summary: "Stop one task-bound service through the Host (gated)",
    description:
      "Ask the Host to stop `serviceId`, a service this task has bound. Only the child the Host itself registered for this service is stopped. The permission gate decides first: a read-only session is refused, `default` asks for one confirmation (rejection, cancellation or expiry performs no action), and one confirmation authorizes exactly one start or stop. An unknown or foreign `serviceId` stops nothing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["serviceId"],
      properties: { serviceId: { type: "string", description: "Id of a service bound to this task" } },
    },
  },
  // [PiDock 04] #7 box 6: the Agent's shared-template edit. `kind: "command"` is
  // deliberate and is the tier fact, not a label for what the tool does: the one
  // tier rule asks only for `command`/`browser`, so a `write`-kind tool would
  // rewrite a CROSS-TASK shared template under `default` with no confirmation. A
  // shared template is not task content (`fs.write`'s in-task write) - see
  // `docs/design-notes.md` 共享模板确认 - so this tool asks under `default` too,
  // and the gate's name-scoped rule makes it ask under `auto` as well. The edit
  // content is the same shape the shell's `update` op takes.
  {
    name: SERVICE_TEMPLATE_TOOL,
    kind: "command",
    summary: "Edit a task-bound service's shared template (diff confirmation first)",
    description:
      "Propose an edit to the SHARED template of `serviceId`, a service this task has bound. `descriptor`, `shared` rows and the optional `dependencies` declaration are the whole edit; the Host derives the project, the environment and the pinned version from this task's own binding, so naming any of them is refused, and a `serviceId` this task has not bound is refused by name. The Host computes the real row-level diff from the persisted template and asks the user before anything is written: a read-only session is refused, and `default` and `auto` both ask for one confirmation (rejection, cancellation or expiry writes nothing). The answer carries the before/after rows and the list of task bindings that would need an explicit restart - this tool never starts, stops or restarts a process.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["serviceId", "descriptor", "shared"],
      properties: {
        serviceId: { type: "string", description: "Id of a service bound to this task" },
        descriptor: { type: "object", description: "Shared launch fields: name, program, args, ports, runType, optional healthCheck/workdir" },
        shared: { type: "array", description: "The full shared rows of the revision: [{key, value, secret?}]" },
        dependencies: { type: "array", description: "Optional 服务依赖声明 rows: [{to, kind: \"call\"|\"prestart\"}]" },
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
    "You may read files anywhere inside the task folder (the Host's own `.pidock-*` state and `task.json` are not task content). Every path and command working directory must stay inside this task; a path that escapes (an absolute path outside, `..`, a symlink pointing outside, an original checkout, another task or an application-private path) is refused before it takes effect.",
    "Available tools:",
    "- fs.read: read a file (args: path, optional offset/limit)",
    "- fs.search: list a directory or search files by pattern (args: path, optional pattern)",
    "- fs.write: create or overwrite a file in a worktree (args: path, content)",
    "- exec.run: run a shell command in a worktree (args: command, optional cwd)",
    "- service.status: read a task-bound service's real state (args: serviceId)",
    "- service.logs: read a task-bound service's bounded log tail (args: serviceId, optional limit)",
    "- service.start / service.stop: start or stop a task-bound service through the Host (args: serviceId)",
    "- service.template.update: edit a task-bound service's shared template (args: serviceId, descriptor, shared, optional dependencies)",
    "Every write and command is subject to the task's permission gate and write lock: a refusal comes back as a tool result with a reason, so adapt instead of retrying the same call.",
    "The service tools name only a `serviceId` this task has bound; the Host resolves the program, working directory, effective environment, logs and process identity itself, so a call can never name a program, a path, a port or an environment value. `service.start`/`service.stop` are refused in a read-only session, ask the user first under `default` (a rejection, cancellation or expiry performs no action, and one confirmation authorizes exactly one start or stop), and are allowed under `auto`.",
    "`service.template.update` edits the SHARED template of a service this task has bound: name the `serviceId` and the edit content (`descriptor`, the full `shared` rows, optional `dependencies`) and nothing else - the home project, the environment and the pinned version come from this task's own binding, so naming one of them is refused. The Host returns the real row-level diff computed from the persisted template, the user confirms it (a read-only session is refused, and both `default` and `auto` ask before anything is written), and the answer lists the task bindings that need an explicit restart. Editing a shared template starts, stops and restarts nothing.",
    "`exec.run` runs a real shell through a filter, not a sandbox: a command containing `$` or a backtick is refused outright (no approval is offered, even under `default`), a token naming `.git` is refused whatever its case, quoting or simple backslash escapes (`echo x > .g\\it` is the same control file as `echo x > .git`), and only path-shaped tokens (`/`, `~`, `..`) are examined at all. Never treat it as an isolation boundary.",
  ].join("\n");
}
