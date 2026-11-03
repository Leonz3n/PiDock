import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ProviderSecretStore, createTestSafeStorage, UNAVAILABLE_SAFE_STORAGE, isProviderProfileId } from "./provider-secret-store.js";

const PROFILE = "p-11111111-2222-3333-4444-555555555555";
const OTHER = "p-99999999-8888-7777-6666-555555555555";
const SECRET = "sk-live-0123456789-abcdefghijklmnop";

function store(storage = createTestSafeStorage()) {
  const dir = mkdtempSync(join(tmpdir(), "pidock-provider-secret-"));
  return { dir, file: join(dir, "provider-secrets.json"), store: new ProviderSecretStore(dir, storage, () => "2026-11-02T00:00:00.000Z") };
}

it("encrypts a credential and decrypts the same value back", () => {
  const { store: secrets } = store();
  expect(secrets.available()).toBe(true);
  expect(secrets.has(PROFILE)).toBe(false);
  expect(secrets.set(PROFILE, SECRET)).toBe(1);
  expect(secrets.has(PROFILE)).toBe(true);
  expect(secrets.resolve(PROFILE)).toBe(SECRET);
  expect(secrets.has(OTHER)).toBe(false);
});

it("persists ciphertext only, with private file modes", () => {
  const { dir, file, store: secrets } = store();
  secrets.set(PROFILE, SECRET);
  const raw = readFileSync(file, "utf8");
  expect(raw).not.toContain(SECRET);
  expect(raw).not.toContain("sk-live");
  // The plaintext never appears even in encoded form: only the ciphertext field.
  expect(raw).toContain("ciphertext");
  expect(JSON.parse(raw)).toMatchObject({ version: 1, secrets: { [PROFILE]: { revision: 1 } } });
  if (process.platform !== "win32") {
    // Named skip not needed: the comparison is a plain read of POSIX bits.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  }
});

it("bumps a per-profile revision so a replaced key can invalidate a session binding", () => {
  const { store: secrets } = store();
  expect(secrets.set(PROFILE, SECRET)).toBe(1);
  expect(secrets.set(PROFILE, `${SECRET}-rotated`)).toBe(2);
  expect(secrets.resolve(PROFILE)).toBe(`${SECRET}-rotated`);
  expect(secrets.revision(PROFILE)).toBe(2);
  expect(secrets.revision(OTHER)).toBeNull();
  secrets.remove(PROFILE);
  expect(secrets.revision(PROFILE)).toBeNull();
  expect(() => secrets.resolve(PROFILE)).toThrow("provider-secret-missing");
});

it("refuses to store anything when the platform cannot encrypt", () => {
  const { dir, file, store: secrets } = store(createTestSafeStorage(false));
  expect(secrets.available()).toBe(false);
  expect(() => secrets.set(PROFILE, SECRET)).toThrow("provider-secret-store-unavailable");
  // Refusal must not leave a plaintext (or any) file behind.
  expect(() => readFileSync(file, "utf8")).toThrow();
  expect(statSync(dir).isDirectory()).toBe(true);

  const unavailable = new ProviderSecretStore(dir, UNAVAILABLE_SAFE_STORAGE);
  expect(() => unavailable.set(PROFILE, SECRET)).toThrow("provider-secret-store-unavailable");
  expect(() => readFileSync(file, "utf8")).toThrow();
});

it("fails closed on an unreadable, foreign or corrupted document", () => {
  const { file, store: secrets } = store();
  secrets.set(PROFILE, SECRET);
  const good = readFileSync(file, "utf8");

  writeFileSync(file, "{ not json");
  expect(() => secrets.resolve(PROFILE)).toThrow("provider-secret-unreadable");
  writeFileSync(file, JSON.stringify({ version: 2, secrets: {} }));
  expect(() => secrets.resolve(PROFILE)).toThrow("provider-secret-unreadable");
  writeFileSync(file, JSON.stringify({ version: 1, secrets: { "not-a-profile": { revision: 1, ciphertext: "AAAA", updatedAt: "x" } } }));
  expect(() => secrets.resolve(PROFILE)).toThrow("provider-secret-unreadable");
  writeFileSync(file, JSON.stringify({ version: 1, secrets: { [PROFILE]: { revision: 1, ciphertext: "not base64!!", updatedAt: "x" } } }));
  expect(() => secrets.resolve(PROFILE)).toThrow("provider-secret-unreadable");

  writeFileSync(file, good);
  expect(secrets.resolve(PROFILE)).toBe(SECRET);
});

it("reports a rotated-away OS keychain entry as unreadable, not as a usable credential", () => {
  const { dir, file, store: secrets } = store();
  secrets.set(PROFILE, SECRET);
  // Simulate a keychain reset: the ciphertext survives but a different OS key decrypts it.
  const rotated = new ProviderSecretStore(dir, createTestSafeStorage(true, Buffer.alloc(32, 9)));
  expect(() => rotated.resolve(PROFILE)).toThrow("provider-secret-unreadable");
  expect(readFileSync(file, "utf8")).not.toContain(SECRET);
});

it("rejects values that are too short, too long, or not strings", () => {
  const { store: secrets } = store();
  expect(() => secrets.set(PROFILE, "short")).toThrow("provider-secret-invalid");
  expect(() => secrets.set(PROFILE, "x".repeat(4097))).toThrow("provider-secret-invalid");
  expect(() => secrets.set(PROFILE, `abc\0defgh`)).toThrow("provider-secret-invalid");
  expect(() => secrets.set(PROFILE, 42 as unknown as string)).toThrow("provider-secret-invalid");
  expect(() => secrets.set("not-a-profile", SECRET)).toThrow("provider-secret-profile-invalid");
  expect(isProviderProfileId(PROFILE)).toBe(true);
  expect(isProviderProfileId("p-1")).toBe(false);
});
