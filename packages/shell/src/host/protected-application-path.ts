import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Trusted main/Host callbacks only; no renderer-supplied protected paths. */
export interface TaskPathProtection { assert(path: string): void }
function fail(): never { throw Error("protected-application-path: 应用私有目录或其身份不可用于任务工具"); }
function contains(parent: string, child: string): boolean {
  const delta = relative(parent, child);
  return delta === "" || (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${sep}`));
}
/** Resolve missing descendants without treating dangling links or access errors as absence. */
function prospectiveRealPath(path: string): string {
  const suffix: string[] = []; let current = resolve(path);
  for (let depth = 0; depth < 256; depth++) {
    try {
      lstatSync(current);
      return join(realpathSync(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail();
      // A present symlink whose target is missing must not become an allowed lexical path.
      try { lstatSync(current); fail(); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ENOENT") fail(); }
      const parent = dirname(current); if (parent === current) fail();
      suffix.unshift(basename(current)); current = parent;
    }
  }
  return fail();
}
/** Snapshot identity guard, not atomic open authorization, inode provenance or an OS sandbox. */
export function protectApplicationProfile(profile: string): TaskPathProtection {
  try {
    if (!isAbsolute(profile) || profile.includes("\0") || profile.length > 4096 || profile.split(/[\\/]/).some((part) => part === "." || part === "..")) fail();
    const real = realpathSync(profile), identity = lstatSync(real, { bigint: true });
    if (!identity.isDirectory()) fail();
    return Object.freeze({ assert(path: string) {
      try {
        if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || path.length > 4096 || path.split(/[\\/]/).some((part) => part === "." || part === "..")) fail();
        const current = lstatSync(real, { bigint: true });
        if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino || realpathSync(profile) !== real) fail();
        const target = prospectiveRealPath(path);
        try { const stat = lstatSync(target); if (stat.isFile() && stat.nlink > 1) fail(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(); }
        // Ancestor sources are denied wholesale: listing/searching them could include the profile.
        if (contains(real, target) || contains(target, real)) fail();
      } catch { fail(); }
    } });
  } catch { return fail(); }
}
