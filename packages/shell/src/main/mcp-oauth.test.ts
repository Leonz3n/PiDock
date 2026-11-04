import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NativeMcpFile } from "./native-mcp-config.js";
import { McpWiring } from "./mcp-ipc.js";
import { createTestSafeStorage } from "./provider-secret-store.js";
import { McpOAuth } from "./mcp-oauth.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("reports a real signed-out native HTTP server without exposing private configuration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { native: { url: "https://example.test/mcp", oauth: { clientRegistration: "dcr", clientSecret: "private-hidden-secret" } } } }));
  const file = new NativeMcpFile(dir);
  const oauth = await McpOAuth.create(file, dir, createTestSafeStorage(), async () => undefined);
  const wiring = new McpWiring(file, {}, undefined, oauth);
  const result = await wiring.perform({ op: "oauth-status", name: "native" });
  expect(result).toEqual({ state: "signed-out", error: null });
  expect(JSON.stringify(wiring.list())).not.toContain("private-hidden-secret");
  await oauth.close();
});

it("signs in using upstream PKCE and consumes the private grant through the public connection test", async () => {
  const { oauthFixture } = await import("../../scripts/fixtures/mcp-oauth-server.mjs");
  const server = await oauthFixture();
  const dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { native: { url: `${server.base}/mcp`, oauth: { clientRegistration: "dcr" } } } }));
  const file = new NativeMcpFile(dir);
  const oauth = await McpOAuth.create(file, dir, createTestSafeStorage(), async url => { await fetch(url); });
  const wiring = new McpWiring(file, {}, undefined, oauth);
  try {
    expect(await wiring.perform({ op: "oauth-start", name: "native" })).toMatchObject({ state: "signing-in" });
    await expect.poll(async () => (await wiring.perform({ op: "oauth-status", name: "native" }) as { state: string }).state).toBe("signed-in");
    expect(server.registrations).toHaveLength(1);
    expect(await wiring.perform({ op: "test", name: "native" })).toMatchObject({ state: "connected", tools: [{ name: "echo" }] });
  } finally { await oauth.close(); await server.close(); }
});

it("cancels an outstanding native login, rejects late callbacks, and keeps exact-name accounts separate", async () => {
  const { oauthFixture } = await import("../../scripts/fixtures/mcp-oauth-server.mjs");
  const server = await oauthFixture();
  const dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  const config = { mcpServers: { "same-name": { url: `${server.base}/mcp`, oauth: { clientRegistration: "dcr" } }, same_name: { url: `${server.base}/mcp` } } };
  writeFileSync(join(dir, "mcp.json"), JSON.stringify(config));
  let browser: string | undefined;
  const oauth = await McpOAuth.create(new NativeMcpFile(dir), dir, createTestSafeStorage(), async url => { browser = url; });
  const wiring = new McpWiring(new NativeMcpFile(dir), {}, undefined, oauth);
  try {
    await wiring.perform({ op: "oauth-start", name: "same-name" });
    await expect.poll(() => browser).toBeTruthy();
    const authorization = browser!;
    expect(await wiring.perform({ op: "oauth-cancel", name: "same-name" })).toEqual({ state: "cancelled", error: null });
    await fetch(authorization).catch(() => undefined);
    expect(await wiring.perform({ op: "oauth-status", name: "same-name" })).toEqual({ state: "cancelled", error: null });
    expect(await wiring.perform({ op: "test", name: "same_name" })).toMatchObject({ state: "failed", error: { code: "mcp-auth-required" } });
  } finally { await oauth.close(); await server.close(); }
});

it.each(["auto", "cimd", "explicit"])("preserves native %s registration semantics and durable ownership", async mode => {
  const { oauthFixture } = await import("../../scripts/fixtures/mcp-oauth-server.mjs");
  const server = await oauthFixture(), dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  const settings = mode === "explicit" ? { clientId: "explicit-client", clientRegistration: "dcr" } : { clientRegistration: mode };
  const config = { mcpServers: { "account-a": { url: `${server.base}/mcp`, oauth: settings }, account_a: { url: `${server.base}/mcp` } } };
  writeFileSync(join(dir, "mcp.json"), JSON.stringify(config));
  const file = new NativeMcpFile(dir), cipher = createTestSafeStorage();
  const oauth = await McpOAuth.create(file, dir, cipher, async url => { await fetch(url); });
  try {
    await oauth.start("account-a");
    await expect.poll(async () => (await oauth.status("account-a")).state).toBe("signed-in");
    expect(server.registrations).toHaveLength(0);
    expect(server.requests.find((request: { kind: string }) => request.kind === "authorize")).toMatchObject({ clientId: mode === "explicit" ? "explicit-client" : "https://pi.dev/oauth/client.json" });
    expect(await oauth.status("account_a")).toEqual({ state: "signed-out", error: null });
    const restarted = await McpOAuth.create(file, dir, cipher, async () => undefined);
    expect(await restarted.status("account-a")).toEqual({ state: "signed-in", error: null });
    config.mcpServers["account-a"].url = `${server.base}/different-target`;
    writeFileSync(file.path, JSON.stringify(config));
    expect(await restarted.status("account-a")).toEqual({ state: "signed-out", error: null });
    await restarted.close();
  } finally { await oauth.close(); await server.close(); }
});

it.each(["failure", "unsafe", "mismatch", "stale"])("handles %s authorization without installing a grant", async mode => {
  const { oauthFixture } = await import("../../scripts/fixtures/mcp-oauth-server.mjs");
  const server = await oauthFixture(), dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  server.mode(mode === "stale" ? "success" : mode);
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { native: { url: `${server.base}/mcp`, oauth: { clientRegistration: "dcr" } } } }));
  let opened = 0, browserStatus = 0;
  const file = new NativeMcpFile(dir);
  const oauth = await McpOAuth.create(file, dir, createTestSafeStorage(), async url => {
    opened++;
    if (mode === "stale") writeFileSync(file.path, JSON.stringify({ mcpServers: { native: { url: `${server.base}/other` } } }));
    browserStatus = (await fetch(url)).status;
  });
  try {
    await oauth.start("native");
    if (mode === "mismatch") {
      await expect.poll(() => browserStatus).toBe(400);
      expect((await oauth.status("native")).state).toBe("signing-in");
      expect(server.requests.filter((request: { kind: string }) => request.kind === "token")).toHaveLength(0);
      expect(await oauth.cancel("native")).toEqual({ state: "cancelled", error: null });
    } else if (mode === "stale") {
      await expect.poll(() => browserStatus).toBe(200);
      expect((await oauth.status("native")).state).toBe("signed-out");
    } else {
      await expect.poll(async () => (await oauth.status("native")).state).toBe("failed");
      if (mode === "unsafe") expect(opened).toBe(0);
      expect(JSON.stringify(await oauth.status("native"))).not.toMatch(/private-|file:/);
    }
  } finally { await oauth.close(); await server.close(); }
});

it.each([
  { callbackUrl: "file:///tmp/callback" },
  { callbackUrl: "https://example.test/callback" },
  { callbackUrl: "http://localhost:1234/callback", callbackPort: 2345 },
  { clientRegistration: "cimd", clientId: "forbidden-combo" },
  { clientRegistration: "cimd", callbackUrl: "http://localhost/other" },
])("rejects unsafe native callback/registration combinations before opening a browser: %j", async settings => {
  const dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { native: { url: "https://example.test/mcp", oauth: settings } } }));
  let opened = false;
  const file = new NativeMcpFile(dir), oauth = await McpOAuth.create(file, dir, createTestSafeStorage(), async () => { opened = true; });
  const wiring = new McpWiring(file, {}, undefined, oauth);
  await expect(wiring.perform({ op: "oauth-start", name: "native" })).rejects.toMatchObject({ code: "mcp-oauth-config-invalid" });
  await expect(wiring.perform({ op: "oauth-start", name: "native", url: "file:///tmp/escape" })).rejects.toMatchObject({ code: "invalid-payload" });
  expect(opened).toBe(false);
  await oauth.close();
});


it("reports token expiry from durable state, encrypts private files, and refreshes before a real connection", async () => {
  const { oauthFixture } = await import("../../scripts/fixtures/mcp-oauth-server.mjs");
  const server = await oauthFixture(), dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { native: { url: `${server.base}/mcp`, oauth: { clientRegistration: "dcr" } } } }));
  const file = new NativeMcpFile(dir), oauth = await McpOAuth.create(file, dir, createTestSafeStorage(), async url => { await fetch(url); });
  try {
    await oauth.start("native");
    await expect.poll(async () => (await oauth.status("native")).state).toBe("signed-in");
    const states = readdirSync(oauth.binding.directory, { recursive: true }).filter(path => String(path).endsWith("state.json"));
    expect(states).toHaveLength(1);
    const statePath = join(oauth.binding.directory, String(states[0]));
    expect(readFileSync(statePath, "utf8")).not.toMatch(/private-access|private-refresh|codeVerifier|oauthState/);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    const time = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(time + 3_600_001);
    try {
      expect(await oauth.status("native")).toEqual({ state: "expired", error: null });
      const wiring = new McpWiring(file, {}, undefined, oauth);
      expect(await wiring.perform({ op: "test", name: "native" })).toMatchObject({ state: "connected" });
      expect(server.requests.some((request: { grant?: string }) => request.grant === "refresh_token")).toBe(true);
    } finally { clock.mockRestore(); }
  } finally { await oauth.close(); await server.close(); }
});

it("shutdown cancels queued login before browser startup and refuses new login until an aborted quit resumes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { native: { url: "https://example.test/mcp" } } }));
  let opens = 0;
  const oauth = await McpOAuth.create(new NativeMcpFile(dir), dir, createTestSafeStorage(), async () => { opens++; });
  const queued = oauth.start("native");
  await oauth.close();
  await expect(queued).rejects.toThrow("mcp-oauth-closing");
  await expect(oauth.start("native")).rejects.toThrow("mcp-oauth-closing");
  expect(opens).toBe(0);
  oauth.resume();
  expect(await oauth.status("native")).toMatchObject({ state: "signed-out" });
});

it("refuses unavailable encryption and corrupt private state without a plaintext fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { native: { url: "https://example.test/mcp" } } }));
  const file = new NativeMcpFile(dir);
  await expect(McpOAuth.create(file, dir, createTestSafeStorage(false), async () => undefined)).rejects.toThrow("mcp-private-store-unavailable");
  expect(readdirSync(dir)).toEqual(["mcp.json"]);
  const oauth = await McpOAuth.create(file, dir, createTestSafeStorage(), async () => undefined);
  await oauth.status("native");
  const state = readdirSync(oauth.binding.directory, { recursive: true }).find(path => String(path).endsWith("state.json"))!;
  const path = join(oauth.binding.directory, String(state));
  writeFileSync(path, '{"unexpected":"private-plaintext"}');
  await expect(oauth.status("native")).rejects.toThrow("mcp-private-store-unreadable");
  expect(readFileSync(path, "utf8")).toBe('{"unexpected":"private-plaintext"}');
  await oauth.close();
});


it("keeps a challenged browser login cancellable and rejects its late callback before a fresh login", async () => {
  const { oauthFixture } = await import("../../scripts/fixtures/mcp-oauth-server.mjs");
  const server = await oauthFixture(), dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { native: { url: `${server.base}/mcp`, oauth: { clientRegistration: "dcr" } } } }));
  let browser: string | undefined;
  const file = new NativeMcpFile(dir), cipher = createTestSafeStorage();
  const oauth = await McpOAuth.create(file, dir, cipher, async url => { browser = url; });
  const wiring = new McpWiring(file, {}, undefined, oauth);
  try {
    await wiring.perform({ op: "oauth-start", name: "native" });
    await expect.poll(() => browser).toBeTruthy();
    const stale = browser!;
    expect(await wiring.perform({ op: "test", name: "native" })).toMatchObject({ state: "failed", error: { code: "mcp-auth-required" } });
    expect(await wiring.perform({ op: "oauth-cancel", name: "native" })).toEqual({ state: "cancelled", error: null });
    await expect(fetch(stale)).rejects.toThrow();
    expect(server.requests.filter((request: { kind: string }) => request.kind === "token")).toHaveLength(0);
    const restarted = await McpOAuth.create(file, dir, cipher, async () => undefined);
    try { expect(await restarted.status("native")).toEqual({ state: "signed-out", error: null }); }
    finally { await restarted.close(); }
    browser = undefined;
    await wiring.perform({ op: "oauth-start", name: "native" });
    await expect.poll(() => browser).toBeTruthy();
    expect((await fetch(browser!)).status).toBe(200);
    await expect.poll(async () => (await oauth.status("native")).state).toBe("signed-in");
    expect(await wiring.perform({ op: "test", name: "native" })).toMatchObject({ state: "connected" });
  } finally { await oauth.close(); await server.close(); }
});


it("shutdown drains a challenged login and closes its callback without installing credentials", async () => {
  const { oauthFixture } = await import("../../scripts/fixtures/mcp-oauth-server.mjs");
  const server = await oauthFixture(), dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { native: { url: `${server.base}/mcp` } } }));
  let browser: string | undefined;
  const file = new NativeMcpFile(dir), cipher = createTestSafeStorage();
  const oauth = await McpOAuth.create(file, dir, cipher, async url => { browser = url; });
  const wiring = new McpWiring(file, {}, undefined, oauth);
  try {
    await wiring.perform({ op: "oauth-start", name: "native" });
    await expect.poll(() => browser).toBeTruthy();
    expect(await wiring.perform({ op: "test", name: "native" })).toMatchObject({ error: { code: "mcp-auth-required" } });
    await oauth.close();
    await expect(fetch(browser!)).rejects.toThrow();
    expect(server.requests.filter((request: { kind: string }) => request.kind === "token")).toHaveLength(0);
    const restarted = await McpOAuth.create(file, dir, cipher, async () => undefined);
    try { expect(await restarted.status("native")).toEqual({ state: "signed-out", error: null }); }
    finally { await restarted.close(); }
    await expect(oauth.start("native")).rejects.toThrow("mcp-oauth-closing");
    oauth.resume(); browser = undefined;
    await oauth.start("native");
    await expect.poll(() => browser).toBeTruthy();
    expect((await fetch(browser!)).status).toBe(200);
    await expect.poll(async () => (await oauth.status("native")).state).toBe("signed-in");
  } finally { await oauth.close(); await server.close(); }
});


it("an older transport challenge cannot orphan a newer browser login", async () => {
  const { oauthFixture } = await import("../../scripts/fixtures/mcp-oauth-server.mjs");
  const { testMcpConnection } = await import("./mcp-connection-test.js");
  const server = await oauthFixture(), dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { native: { url: `${server.base}/mcp` } } }));
  let browser: string | undefined;
  const file = new NativeMcpFile(dir), oauth = await McpOAuth.create(file, dir, createTestSafeStorage(), async url => { browser = url; });
  const oldTransportAuth = await oauth.auth("native");
  try {
    await oauth.start("native");
    await expect.poll(() => browser).toBeTruthy();
    const first = browser!;
    await oauth.cancel("native"); browser = undefined;
    await oauth.start("native");
    await expect.poll(() => browser).toBeTruthy();
    const second = browser!;
    expect(await testMcpConnection(file.entry("native"), { authProvider: oldTransportAuth })).toMatchObject({ error: { code: "mcp-auth-required" } });
    expect(await oauth.status("native")).toEqual({ state: "signing-in", error: null });
    expect(await oauth.cancel("native")).toEqual({ state: "cancelled", error: null });
    await expect(fetch(first)).rejects.toThrow();
    await expect(fetch(second)).rejects.toThrow();
    expect(server.requests.filter((request: { kind: string }) => request.kind === "token")).toHaveLength(0);
  } finally { await oldTransportAuth.settled(); await oauth.close(); await server.close(); }
});


it.each(["save", "disable", "remove"] as const)("%s cancels and drains a challenged login before mutating managed configuration", async op => {
  const { oauthFixture } = await import("../../scripts/fixtures/mcp-oauth-server.mjs");
  const server = await oauthFixture(), dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  const file = new NativeMcpFile(dir), cipher = createTestSafeStorage();
  const { name } = file.add({ transport: "http", url: `${server.base}/mcp` });
  let browser: string | undefined;
  const oauth = await McpOAuth.create(file, dir, cipher, async url => { browser = url; });
  const wiring = new McpWiring(file, {}, undefined, oauth);
  try {
    const original = readFileSync(file.path, "utf8");
    await wiring.perform({ op: "oauth-start", name });
    await expect.poll(() => browser).toBeTruthy();
    expect(await wiring.perform({ op: "test", name })).toMatchObject({ error: { code: "mcp-auth-required" } });
    await wiring.perform(op === "save" ? { op, name, input: { transport: "http", url: `${server.base}/other-target` } } : { op, name });
    await expect(fetch(browser!)).rejects.toThrow();
    expect(server.requests.filter((request: { kind: string }) => request.kind === "token")).toHaveLength(0);
    const servers = wiring.list().servers;
    if (op === "save") expect(servers).toMatchObject([{ name, url: `${server.base}/other-target` }]);
    else if (op === "disable") expect(servers).toMatchObject([{ name, enabled: false }]);
    else expect(servers).toEqual([]);
    // Restore only this temporary managed entry to its original URL to verify
    // durable credential absence independently of the in-memory login status.
    writeFileSync(file.path, original);
    const restarted = await McpOAuth.create(file, dir, cipher, async () => undefined);
    try { expect(await restarted.status(name)).toEqual({ state: "signed-out", error: null }); }
    finally { await restarted.close(); }
  } finally { await oauth.close(); await server.close(); }
});


it("uses challenge-only resource metadata for the next explicit login", async () => {
  const { oauthFixture } = await import("../../scripts/fixtures/mcp-oauth-server.mjs");
  const server = await oauthFixture(), dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  server.challengeOnly(true);
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { native: { url: `${server.base}/mcp`, oauth: { clientRegistration: "dcr" } } } }));
  const file = new NativeMcpFile(dir), oauth = await McpOAuth.create(file, dir, createTestSafeStorage(), async url => { await fetch(url); });
  const wiring = new McpWiring(file, {}, undefined, oauth);
  try {
    expect(await wiring.perform({ op: "test", name: "native" })).toMatchObject({ error: { code: "mcp-auth-required" } });
    await wiring.perform({ op: "oauth-start", name: "native" });
    await expect.poll(async () => (await oauth.status("native")).state).toBe("signed-in");
    expect(await wiring.perform({ op: "test", name: "native" })).toMatchObject({ state: "connected" });
  } finally { await oauth.close(); await server.close(); }
});

it("reauthorizes missing scopes while retaining the previous grant and avoiding refresh-token races", async () => {
  const { oauthFixture } = await import("../../scripts/fixtures/mcp-oauth-server.mjs");
  const server = await oauthFixture(), dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  const file = new NativeMcpFile(dir);
  writeFileSync(file.path, JSON.stringify({ mcpServers: { native: { url: `${server.base}/mcp`, oauth: { clientRegistration: "dcr", scope: "read" } } } }));
  const oauth = await McpOAuth.create(file, dir, createTestSafeStorage(), async url => { await fetch(url); });
  const wiring = new McpWiring(file, {}, undefined, oauth);
  try {
    await oauth.start("native");
    await expect.poll(async () => (await oauth.status("native")).state).toBe("signed-in");
    server.requireScope("write");
    expect(await wiring.perform({ op: "test", name: "native" })).toMatchObject({ error: { code: "mcp-auth-required" } });
    // The new configuration is narrower than the grant; the challenge lists
    // only the missing scope. Upstream must merge all three sources.
    writeFileSync(file.path, JSON.stringify({ mcpServers: { native: { url: `${server.base}/mcp`, oauth: { clientRegistration: "dcr", scope: "profile" } } } }));
    await oauth.start("native");
    await expect.poll(async () => (await oauth.status("native")).state).toBe("signed-in");
    const authorizations = server.requests.filter((request: { kind: string }) => request.kind === "authorize");
    expect(authorizations.at(-1).scope.split(/\s+/).sort()).toEqual(["profile", "read", "write"]);
    expect(server.requests.filter((request: { grant?: string }) => request.grant === "refresh_token")).toHaveLength(0);
    expect(await wiring.perform({ op: "test", name: "native" })).toMatchObject({ state: "connected" });
  } finally { await oauth.close(); await server.close(); }
});

it("keeps late transport challenges scoped to their original URL and exact server name", async () => {
  const { oauthFixture } = await import("../../scripts/fixtures/mcp-oauth-server.mjs");
  const { testMcpConnection } = await import("./mcp-connection-test.js");
  const first = await oauthFixture(), second = await oauthFixture(), dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  first.challengeOnly(true);
  const file = new NativeMcpFile(dir);
  writeFileSync(file.path, JSON.stringify({ mcpServers: { account: { url: `${first.base}/mcp` }, other: { url: `${first.base}/mcp` } } }));
  const oauth = await McpOAuth.create(file, dir, createTestSafeStorage(), async url => { await fetch(url); });
  const oldAuth = await oauth.auth("account");
  try {
    writeFileSync(file.path, JSON.stringify({ mcpServers: { account: { url: `${second.base}/mcp` }, other: { url: `${first.base}/mcp` } } }));
    expect(await testMcpConnection({ url: `${first.base}/mcp` }, { authProvider: oldAuth })).toMatchObject({ error: { code: "mcp-auth-required" } });
    await oauth.start("account");
    await expect.poll(async () => (await oauth.status("account")).state).toBe("signed-in");
    expect(second.requests.filter((request: { kind: string }) => request.kind === "authorize")).toHaveLength(1);
    expect(first.requests.filter((request: { kind: string }) => request.kind === "authorize")).toHaveLength(0);
    await oauth.start("other");
    await expect.poll(async () => (await oauth.status("other")).state).toBe("failed");
  } finally { await oldAuth.settled(); await oauth.close(); await first.close(); await second.close(); }
});

it("cancelled step-up login leaves the existing grant usable and can retry the missing scope", async () => {
  const { oauthFixture } = await import("../../scripts/fixtures/mcp-oauth-server.mjs");
  const server = await oauthFixture(), dir = mkdtempSync(join(tmpdir(), "pidock-oauth-")); dirs.push(dir);
  const file = new NativeMcpFile(dir);
  writeFileSync(file.path, JSON.stringify({ mcpServers: { native: { url: `${server.base}/mcp`, oauth: { scope: "read" } } } }));
  let held: string | undefined, hold = false;
  const oauth = await McpOAuth.create(file, dir, createTestSafeStorage(), async url => { if (hold) held = url; else await fetch(url); });
  const wiring = new McpWiring(file, {}, undefined, oauth);
  try {
    await oauth.start("native");
    await expect.poll(async () => (await oauth.status("native")).state).toBe("signed-in");
    server.requireScope("write");
    expect(await wiring.perform({ op: "test", name: "native" })).toMatchObject({ error: { code: "mcp-auth-required" } });
    hold = true; await oauth.start("native");
    await expect.poll(() => held).toBeTruthy();
    expect(await oauth.cancel("native")).toMatchObject({ state: "cancelled" });
    await expect(fetch(held!)).rejects.toThrow();
    expect(server.requests.filter((request: { kind: string }) => request.kind === "token")).toHaveLength(1);
    server.requireScope("");
    expect(await wiring.perform({ op: "test", name: "native" })).toMatchObject({ state: "connected" });
    server.requireScope("write"); hold = false;
    await oauth.start("native");
    await expect.poll(async () => (await oauth.status("native")).state).toBe("signed-in");
    expect(await wiring.perform({ op: "test", name: "native" })).toMatchObject({ state: "connected" });
  } finally { await oauth.close(); await server.close(); }
});
