/**
 * Machine-private credential store for [PiDock T03] #138.
 *
 * The renderer may type an API key once; main encrypts it with Electron
 * `safeStorage` (the OS keychain-backed cipher) and persists **only the
 * ciphertext** in `<userData>/provider-secrets.json` (0600, atomic write). The
 * plaintext is never written to disk, never returned to a renderer, and never
 * put in a log line or an error message from this module.
 *
 * If the platform cannot encrypt (`safeStorage.isEncryptionAvailable()` is
 * false) the store refuses by name instead of falling back to plaintext: a
 * credential stored in the clear would break the "private" promise the UI
 * makes, so the failure is an explicit state instead of a silent downgrade.
 *
 * The store is keyed by PiDock profile id (`p-<uuid>`) and keeps a monotonically
 * increasing per-profile `revision`, which the profile document pins so a
 * replaced key bumps the SDK configuration generation and invalidates a stale
 * session binding (see `provider-profile-store.ts`).
 */

import { createCipheriv, createDecipheriv, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The slice of Electron's `safeStorage` this module needs (injected, so tests never need Electron). */
export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const FILE = "provider-secrets.json";
const MAX_BYTES = 512 * 1024;
const MAX_SECRET = 4096;
const MIN_SECRET = 8;
const PROFILE = /^p-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isProviderProfileId(value: unknown): value is string {
  return typeof value === "string" && PROFILE.test(value);
}

interface SecretRow {
  revision: number;
  /** Base64 of the `safeStorage` ciphertext. Never a plaintext value. */
  ciphertext: string;
  updatedAt: string;
}

interface Document {
  version: 1;
  secrets: Record<string, SecretRow>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyDocument(): Document {
  return { version: 1, secrets: {} };
}

/** Base64 of a raw key, validated without ever interpreting the plaintext. */
function decodeCiphertext(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BYTES) throw new Error("provider-secret-unreadable");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("provider-secret-unreadable");
  const buffer = Buffer.from(value, "base64");
  if (buffer.length === 0) throw new Error("provider-secret-unreadable");
  return buffer;
}

export class ProviderSecretStore {
  private readonly file: string;

  constructor(
    private readonly directory: string,
    private readonly storage: SafeStoragePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.file = join(directory, FILE);
  }

  /** True only when the platform can actually encrypt; the UI must not offer "save key" otherwise. */
  available(): boolean {
    try { return this.storage.isEncryptionAvailable() === true; } catch { return false; }
  }

  private read(): Document {
    if (!existsSync(this.file)) return emptyDocument();
    const stat = lstatSync(this.file);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("provider-secret-unreadable");
    let value: unknown;
    try { value = JSON.parse(readFileSync(this.file, "utf8")); }
    catch { throw new Error("provider-secret-unreadable"); }
    if (!record(value) || value["version"] !== 1) throw new Error("provider-secret-unreadable");
    const secrets = value["secrets"];
    if (!record(secrets) || Object.keys(secrets).length > 50) throw new Error("provider-secret-unreadable");
    const document = emptyDocument();
    for (const [profileId, row] of Object.entries(secrets)) {
      if (!isProviderProfileId(profileId) || !record(row)) throw new Error("provider-secret-unreadable");
      const revision = row["revision"];
      const updatedAt = row["updatedAt"];
      if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new Error("provider-secret-unreadable");
      if (typeof updatedAt !== "string" || updatedAt.length === 0 || updatedAt.length > 64) throw new Error("provider-secret-unreadable");
      document.secrets[profileId] = { revision: revision as number, ciphertext: decodeCiphertext(row["ciphertext"]).toString("base64"), updatedAt };
    }
    return document;
  }

  private write(document: Document): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.file), `.${FILE}.${randomUUID()}.tmp`);
    try {
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify(document));
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
  }

  /** True when a ciphertext exists for this profile (it may still fail to decrypt). */
  has(profileId: string): boolean {
    if (!isProviderProfileId(profileId)) return false;
    return this.read().secrets[profileId] !== undefined;
  }

  /** The stored revision, or `null` when no key is stored for this profile. */
  revision(profileId: string): number | null {
    if (!isProviderProfileId(profileId)) return null;
    return this.read().secrets[profileId]?.revision ?? null;
  }

  /**
   * Encrypts and persists one credential. Refuses by name when the platform
   * cannot encrypt, so there is no plaintext path in the product.
   */
  set(profileId: string, secret: string): number {
    if (!isProviderProfileId(profileId)) throw new Error("provider-secret-profile-invalid");
    if (!this.available()) throw new Error("provider-secret-store-unavailable");
    if (typeof secret !== "string" || secret.length < MIN_SECRET || secret.length > MAX_SECRET || secret.includes("\0")) {
      throw new Error("provider-secret-invalid");
    }
    let ciphertext: Buffer;
    try { ciphertext = this.storage.encryptString(secret); }
    catch { throw new Error("provider-secret-encrypt-failed"); }
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) throw new Error("provider-secret-encrypt-failed");
    const document = this.read();
    const revision = (document.secrets[profileId]?.revision ?? 0) + 1;
    document.secrets[profileId] = { revision, ciphertext: ciphertext.toString("base64"), updatedAt: this.now() };
    this.write(document);
    return revision;
  }

  /**
   * Decrypts the credential for main only. A missing key, a rotated-away OS
   * keychain entry, or a malformed document fails by name; the caller maps it
   * to the bounded `credential-missing` state and never forwards the raw text.
   */
  resolve(profileId: string): string {
    if (!isProviderProfileId(profileId)) throw new Error("provider-secret-missing");
    const row = this.read().secrets[profileId];
    if (!row) throw new Error("provider-secret-missing");
    if (!this.available()) throw new Error("provider-secret-store-unavailable");
    let plain: string;
    try { plain = this.storage.decryptString(decodeCiphertext(row.ciphertext)); }
    catch { throw new Error("provider-secret-unreadable"); }
    if (typeof plain !== "string" || plain.length < MIN_SECRET || plain.length > MAX_SECRET) throw new Error("provider-secret-unreadable");
    return plain;
  }

  remove(profileId: string): void {
    if (!isProviderProfileId(profileId)) throw new Error("provider-secret-profile-invalid");
    const document = this.read();
    if (document.secrets[profileId] === undefined) return;
    delete document.secrets[profileId];
    this.write(document);
  }
}

/**
 * A `SafeStoragePort` that never encrypts. Used by tests and by any code path
 * that must prove "no store" rather than silently persist plaintext.
 */
export const UNAVAILABLE_SAFE_STORAGE: SafeStoragePort = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error("provider-secret-store-unavailable"); },
  decryptString: () => { throw new Error("provider-secret-store-unavailable"); },
};

/**
 * A deterministic AES-256-GCM port over a fixed test key. It exists so the
 * store's encrypt/decrypt round trip and its "ciphertext only" rule can be
 * exercised without Electron; production always injects `safeStorage`.
 */
export function createTestSafeStorage(available = true, key = Buffer.alloc(32, 7)): SafeStoragePort {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText) => {
      if (!available) throw new Error("provider-secret-store-unavailable");
      const iv = Buffer.alloc(12, 1);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString: (encrypted) => {
      if (!available) throw new Error("provider-secret-store-unavailable");
      const iv = encrypted.subarray(0, 12);
      const tag = encrypted.subarray(12, 28);
      const body = encrypted.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    },
  };
}
