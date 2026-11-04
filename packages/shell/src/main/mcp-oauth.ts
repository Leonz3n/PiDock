/** Main-owned native sign-in. Only bounded status ever reaches the renderer. */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeOAuth, privateCredentials, type McpPrivateBinding, type OAuthSettings, type OAuthChallenge } from "../mcp-oauth-native.js";
import type { SafeStoragePort } from "./provider-secret-store.js";
import { NativeMcpFile, McpFailure } from "./native-mcp-config.js";
export type OAuthStatus = { state: "signed-out" | "signing-in" | "signed-in" | "expired" | "cancelled" | "failed"; error: string | null };
interface Attempt { controller: AbortController; done: Promise<void>; status: OAuthStatus; identity: string }
export class McpOAuth {
  private closing = false;
  private attempts = new Map<string, Attempt>();
  private challenges = new Map<string, Map<string, OAuthChallenge>>();
  private operations = new Map<string, Promise<unknown>>();
  private serial<T>(name: string, action: () => Promise<T>): Promise<T> {
    const next = (this.operations.get(name) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.operations.set(name, next);
    void next.finally(() => { if (this.operations.get(name) === next) this.operations.delete(name); }).catch(() => undefined);
    return next;
  }
  private constructor(private readonly file: NativeMcpFile, readonly binding: McpPrivateBinding, private readonly open: (url: string) => Promise<void>, private readonly env: Record<string, string | undefined>) {}
  static async create(file: NativeMcpFile, directory: string, storage: SafeStoragePort, open: (url: string) => Promise<void>, env: Record<string, string | undefined> = process.env): Promise<McpOAuth> {
    // OS-encrypted envelope key; never falls back to plaintext.
    if (!storage.isEncryptionAvailable()) throw Error("mcp-private-store-unavailable");
    const root = join(directory, "mcp-private"); mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, "key");
    let key: string;
    try {
      if (!existsSync(path)) writeFileSync(path, storage.encryptString(randomBytes(32).toString("hex")), { mode: 0o600, flag: "wx" });
      key = storage.decryptString(readFileSync(path));
      if (!/^[a-f0-9]{64}$/.test(key)) throw Error();
    } catch { throw Error("mcp-private-store-unreadable"); }
    await nativeOAuth();
    return new McpOAuth(file, { directory: root, key }, open, env);
  }
  private entry(name: string) {
    const entry = this.file.entry(name);
    if (!entry || typeof entry["url"] !== "string") throw new McpFailure("mcp-oauth-unavailable", "HTTP Server required");
    if (entry["enabled"] === false) throw new McpFailure("mcp-oauth-unavailable", "Server disabled");
    return { entry, url: String(new URL(entry["url"])) };
  }
  async status(name: string): Promise<OAuthStatus> {
    const { url } = this.entry(name), attempt = this.attempts.get(name);
    if (attempt?.identity === url && attempt.status.state !== "signed-in") return attempt.status;
    const store = await privateCredentials(this.binding, name), state = await store.forServer(name, url).load();
    return { state: state?.tokens ? state.tokensExpireAt !== undefined && state.tokensExpireAt <= Date.now() ? "expired" : "signed-in" : "signed-out", error: null };
  }
  start(name: string): Promise<OAuthStatus> { return this.serial(name, () => this.begin(name)); }
  private async begin(name: string): Promise<OAuthStatus> {
    if (this.closing) throw Error("mcp-oauth-closing");
    await this.stop(name);
    const { entry, url } = this.entry(name), native = await nativeOAuth();
    const settings = await this.settings(name, entry);
    const credentials = await privateCredentials(this.binding, name), store = credentials.forServer(name, url);
    const controller = new AbortController();
    const attempt: Attempt = { controller, identity: url, status: { state: "signing-in", error: null }, done: Promise.resolve() };
    this.attempts.set(name, attempt);
    // Stage upstream writes until completion. Cancel/stale callbacks can never
    // install tokens, including after a config URL has changed during sign-in.
    let staged = await store.load();
    // An explicit login always uses the browser. Existing sessions can refresh
    // their own grant concurrently; never race them by consuming its refresh
    // token in a staged, cancellable login.
    if (staged) {
      staged = { ...staged };
      // Upstream merges the previous scope for insufficient_scope challenges.
      // Remove only the refresh token: browser login must not consume a grant
      // being refreshed by a live session, even if this attempt is cancelled.
      if (staged.tokens) { staged.tokens = { ...staged.tokens }; delete staged.tokens.refresh_token; }
    }
    const pending = {
      load: () => staged,
      save: (state: typeof staged) => { if (!controller.signal.aborted) staged = state; },
      withRefreshLock: store.withRefreshLock.bind(store),
    };
    attempt.done = native.signInMcpServer({ serverUrl: url, store: pending as typeof store, settings, challenge: this.challenges.get(name)?.get(url), signal: controller.signal,
      prompt: {
        showAuthorizationUrl: (authorization) => {
          if (!["https:", "http:"].includes(authorization.protocol) || authorization.username || authorization.password) throw Error("unsafe authorization URL");
          // Browser launch failure cancels upstream I/O and is a named failure.
          void this.open(authorization.href).catch(() => { attempt.status = { state: "failed", error: "mcp-oauth-browser-failed" }; controller.abort(); });
        },
        promptForRedirectUrl: (signal) => new Promise((resolve) => { if (signal.aborted) resolve(undefined); else signal.addEventListener("abort", () => resolve(undefined), { once: true }); }),
      },
    }).then(async () => {
      if (controller.signal.aborted || this.file.entry(name)?.["url"] !== entry["url"]) throw Error("stale sign-in");
      if (staged) await store.save(staged);
      attempt.status = { state: "signed-in", error: null };
    }).catch(() => {
      if (attempt.status.state === "failed") return;
      attempt.status = { state: controller.signal.aborted ? "cancelled" : "failed", error: controller.signal.aborted ? null : "mcp-oauth-sign-in-failed" };
    });
    return attempt.status;
  }
  cancel(name: string): Promise<OAuthStatus> { return this.serial(name, () => this.stop(name)); }
  private async stop(name: string): Promise<OAuthStatus> {
    const attempt = this.attempts.get(name);
    if (attempt?.status.state === "signing-in") attempt.controller.abort();
    await attempt?.done;
    return attempt?.status ?? { state: "signed-out", error: null };
  }
  private async settings(name: string, entry: Record<string, unknown>): Promise<OAuthSettings> {
    const native = await nativeOAuth();
    if (typeof native.validateMcpServerConfig(name, entry) === "string") throw new McpFailure("mcp-oauth-config-invalid", "OAuth configuration invalid");
    const raw = entry["oauth"] as Record<string, unknown> | undefined;
    const settings: OAuthSettings = { ...raw } as OAuthSettings;
    if (raw?.["authServerMetadataUrl"]) settings.authServerMetadataUrl = new URL(String(raw["authServerMetadataUrl"]));
    if (typeof raw?.["clientSecret"] === "string") {
      // Resolve references only; never execute native !command configuration.
      const value = raw["clientSecret"];
      if (value.startsWith("!")) throw new McpFailure("mcp-oauth-config-invalid", "command secret unsupported");
      settings.clientSecret = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a: string, b: string) => {
        const resolved = this.env[a ?? b]; if (!resolved) throw new McpFailure("mcp-oauth-config-invalid", "secret reference missing"); return resolved;
      });
    }
    return settings;
  }
  /** Trusted main→Host credential channel only; never returned by mcpOp. */
  async hostBinding(): Promise<McpPrivateBinding> {
    const secrets: NonNullable<McpPrivateBinding["secrets"]> = [];
    for (const { name, entry } of this.file.list()) {
      if (entry["enabled"] === false || typeof entry["url"] !== "string") continue;
      try {
        const settings = await this.settings(name, entry);
        if (settings.clientSecret !== undefined) secrets.push({ name, url: String(new URL(entry["url"])), value: settings.clientSecret });
      } catch { /* The session reports unresolved/invalid server settings by name. */ }
    }
    return { ...this.binding, secrets };
  }
  async auth(name: string) {
    const { entry, url } = this.entry(name), native = await nativeOAuth();
    const store = await privateCredentials(this.binding, name), settings = await this.settings(name, entry);
    return native.createMcpAuthProvider({ serverUrl: url, store: store.forServer(name, url), settings: () => settings,
      // Challenge discovery is independent of browser attempt ownership. An old
      // transport can update only its own name+URL, never cancel a newer login.
      onChallenge: (challenge) => {
        const challenges = this.challenges.get(name) ?? new Map<string, OAuthChallenge>();
        challenges.set(url, challenge);
        this.challenges.set(name, challenges);
      },
    });
  }
  resume(): void { this.closing = false; }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.operations.values()]);
    await Promise.all([...this.attempts.keys()].map((name) => this.stop(name)));
  }
}
