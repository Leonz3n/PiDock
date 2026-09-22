export type ShellCommand =
  | { kind: "window" }
  | { kind: "smoke" }
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
  const versions =
    isEnabled(env["PIDOCK_PRINT_VERSIONS"]) ||
    appArgs.includes("--print-versions");

  if (smoke && versions) {
    throw new Error("conflicting shell command flags: smoke and versions");
  }
  if (smoke) return { kind: "smoke" };
  if (versions) return { kind: "versions" };
  return { kind: "window" };
}
