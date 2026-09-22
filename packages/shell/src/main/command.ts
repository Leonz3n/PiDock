export type ShellCommand =
  | { kind: "window" }
  | { kind: "smoke" }
  | { kind: "task-browser-smoke" }
  | { kind: "versions" };

type Environment = Readonly<Record<string, string | undefined>>;

function applicationArguments(argv: readonly string[]): readonly string[] {
  const separatorIndex = argv.lastIndexOf("--");
  return separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function resolveShellCommand(
  argv: readonly string[],
  env: Environment,
): ShellCommand {
  const appArgs = applicationArguments(argv);
  const smoke = isEnabled(env["PIDOCK_SMOKE"]) || appArgs.includes("--smoke");
  const taskBrowserSmoke =
    isEnabled(env["PIDOCK_S3_SMOKE"]) || appArgs.includes("--smoke-s3");
  const versions =
    isEnabled(env["PIDOCK_PRINT_VERSIONS"]) ||
    appArgs.includes("--print-versions");

  if ([smoke, taskBrowserSmoke, versions].filter(Boolean).length > 1) {
    throw new Error("conflicting shell command flags");
  }
  if (smoke) return { kind: "smoke" };
  if (taskBrowserSmoke) return { kind: "task-browser-smoke" };
  if (versions) return { kind: "versions" };
  return { kind: "window" };
}
