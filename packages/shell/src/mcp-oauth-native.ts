/** Fixed Pi 1.5 native OAuth adapter. The shipped implementation is internal to
 * coding-agent's package; resolve it relative to that package's public entry.
 * No upstream files or protocol implementation are changed here. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuthProvider } from "@earendil-works/pi-mcp";
import type { McpExtensionOptions } from "@earendil-works/pi-coding-agent";
import type { McpOAuthState, OAuthChallenge } from "@earendil-works/pi-mcp/oauth";

type Credentials = NonNullable<McpExtensionOptions["credentials"]>;
type Backend = { withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T; withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T> };
export interface OAuthSettings { clientId?: string; clientSecret?: string; callbackPort?: number; callbackUrl?: string; scope?: string; clientName?: string; clientRegistration?: "auto" | "dcr" | "cimd"; authServerMetadataUrl?: URL }
interface NativeOAuth {
  McpOAuthCredentialStore: new (backend: Backend, lockDir?: string) => Credentials;
  signInMcpServer(options: { serverUrl: string; store: ReturnType<Credentials["forServer"]>; settings: OAuthSettings; signal: AbortSignal; prompt: { showAuthorizationUrl(url: URL): void; promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined> } }): Promise<void>;
  createMcpAuthProvider(options: { serverUrl: string; store: ReturnType<Credentials["forServer"]>; settings(): OAuthSettings; onChallenge(challenge: OAuthChallenge): void }): AuthProvider & { settled(): Promise<void> };
}
export interface McpPrivateBinding { directory: string; key: string; secrets?: { name: string; url: string; value: string }[] }
const packageEntry = new URL("./dist/index.js", pathToFileURL(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!)).href;
export async function nativeOAuth() {
  const [oauth, auth, config] = await Promise.all([
    import(new URL("./extensions/mcp/oauth.js", packageEntry).href) as Promise<NativeOAuth>,
    import(new URL("./core/auth-storage.js", packageEntry).href) as Promise<{ FileAuthStorageBackend: new (path: string) => Backend }>,
    import(new URL("./core/mcp-servers.js", packageEntry).href) as Promise<{ validateMcpServerConfig(name: string, entry: unknown): Record<string, unknown> | string }>,
  ]);
  return { ...oauth, ...auth, ...config };
}
export function validatePrivateBinding(value: unknown): McpPrivateBinding {
  if (!value || typeof value !== "object") throw Error("mcp-private-binding-invalid");
  if (!["directory,key", "directory,key,secrets"].includes(Object.keys(value).sort().join(","))) throw Error("mcp-private-binding-invalid");
  const { directory, key, secrets } = value as McpPrivateBinding;
  if (typeof directory !== "string" || !/^(\/|[A-Za-z]:[\\/])/.test(directory) || directory.includes("\0") || typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw Error("mcp-private-binding-invalid");
  if (secrets !== undefined && (!Array.isArray(secrets) || secrets.length > 200 || secrets.some(row => !row || Object.keys(row).sort().join(",") !== "name,url,value" || typeof row.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.name) || typeof row.url !== "string" || row.url.length > 4096 || typeof row.value !== "string" || row.value.length > 8192))) throw Error("mcp-private-binding-invalid");
  return { directory, key, ...(secrets === undefined ? {} : { secrets }) };
}
function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return JSON.stringify({ version: 1, ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64") });
}
function decrypt(value: string | undefined, key: Buffer): string | undefined {
  if (!value?.trim() || value.trim() === "{}") return undefined;
  try {
    if (value.length > 2_000_000) throw Error();
    const parsed = JSON.parse(value) as { version: number; ciphertext: string };
    if (parsed.version !== 1 || typeof parsed.ciphertext !== "string") throw Error();
    const bytes = Buffer.from(parsed.ciphertext, "base64"), cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
  } catch { throw Error("mcp-private-store-unreadable"); }
}
/** Atomic file/refresh locking belongs to upstream; only ciphertext reaches disk.
 * Hash the exact name into separate stores: upstream's tool namespace normalizes
 * '-' to '_', which must never merge two independently named accounts. */
export async function privateCredentials(binding: McpPrivateBinding, name: string): Promise<Credentials> {
  const native = await nativeOAuth(), checked = validatePrivateBinding(binding);
  const directory = join(checked.directory, createHash("sha256").update(name).digest("hex"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const backend = new native.FileAuthStorageBackend(join(directory, "state.json"));
  const key = Buffer.from(checked.key, "hex");
  const encrypted: Backend = {
    withLock: (fn) => backend.withLock((current) => {
      const result = fn(decrypt(current, key));
      return { result: result.result, ...(result.next === undefined ? {} : { next: encrypt(result.next, key) }) };
    }),
    withLockAsync: (fn) => backend.withLockAsync(async (current) => {
      const result = await fn(decrypt(current, key));
      return { result: result.result, ...(result.next === undefined ? {} : { next: encrypt(result.next, key) }) };
    }),
  };
  return new native.McpOAuthCredentialStore(encrypted, directory);
}
/** The extension sees the exact same durable credentials as main. */
export async function extensionCredentials(binding: McpPrivateBinding, names: string[]): Promise<Credentials> {
  const stores = new Map<string, Credentials>();
  for (const name of names) stores.set(name, await privateCredentials(binding, name));
  return {
    forServer: (name: string, url: string) => {
      const store = stores.get(name);
      if (!store) throw Error("mcp-private-server-unbound");
      return store.forServer(name, url);
    },
    tokens: (name: string, url: string) => stores.get(name)?.tokens(name, url),
    remove: (name: string, url: string) => stores.get(name)?.remove(name, url) ?? false,
  } as unknown as Credentials;
}
export type { Credentials, McpOAuthState };
