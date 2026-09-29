import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SdkTextEvent, SdkTextResult } from "./sdk-text-kernel.js";
import type { SdkTurnKernelPort } from "./sdk-kernel-router.js";

export type TurnRecord = {
  taskId: string;
  sessionId: string;
  requestId: string;
  promptFingerprint: string;
  turnId: string;
  state: "accepted" | "done" | "cancelled" | "failed" | "interrupted";
  error?: string;
  lastSequence: number;
  needsResync: boolean;
};

function id(value: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error("invalid-sdk-id");
}

function durableWrite(file: string, value: TurnRecord, exclusive: boolean): void {
  const descriptor = openSync(file, exclusive ? "wx" : "w", 0o600);
  try { writeFileSync(descriptor, JSON.stringify(value)); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function syncDirectory(dir: string): void {
  const descriptor = openSync(dir, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/** Host-owned request journal, separate from the SDK's sole model-context JSONL. */
export class SdkTurnTransport {
  private readonly active = new Map<string, { record: TurnRecord; run: Promise<void> }>();
  private starting = false;
  private uncommitted: TurnRecord | null = null;
  private readonly root: string;

  constructor(private readonly taskId: string, private readonly taskDir: string, private readonly kernel: SdkTurnKernelPort,
    private readonly syncJournalDirectory: (directory: string) => void = syncDirectory) {
    this.root = join(taskDir, ".pidock-sdk-turns");
  }

  private file(sessionId: string, requestId: string): string {
    id(sessionId);
    id(requestId);
    const dir = join(this.root, sessionId);
    if (existsSync(this.root) && (!lstatSync(this.root).isDirectory() || realpathSync(this.root) !== join(realpathSync(this.taskDir), ".pidock-sdk-turns"))) throw new Error("sdk-journal-invalid");
    if (existsSync(dir) && (!lstatSync(dir).isDirectory() || realpathSync(dir) !== join(realpathSync(this.taskDir), ".pidock-sdk-turns", sessionId))) throw new Error("sdk-journal-invalid");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, `${requestId}.json`);
  }

  private read(sessionId: string, requestId: string): TurnRecord | null {
    const file = this.file(sessionId, requestId);
    if (!existsSync(file)) return null;
    if (!lstatSync(file).isFile() || lstatSync(file).size > 2048) throw new Error("sdk-journal-invalid");
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sdk-journal-invalid");
    const record = value as TurnRecord;
    if (record.taskId !== this.taskId || record.sessionId !== sessionId || record.requestId !== requestId ||
        (record.promptFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(record.promptFingerprint)) ||
        typeof record.turnId !== "string" || !/^[a-f0-9-]{36}$/.test(record.turnId) ||
        !["accepted", "done", "cancelled", "failed"].includes(record.state) ||
        !Number.isSafeInteger(record.lastSequence) || record.lastSequence < 0 || typeof record.needsResync !== "boolean") throw new Error("sdk-journal-invalid");
    return record;
  }

  private finish(record: TurnRecord): void {
    const file = this.file(record.sessionId, record.requestId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      durableWrite(temporary, record, true);
      renameSync(temporary, file);
      this.syncJournalDirectory(join(this.root, record.sessionId));
    } finally {
      // A failed rename leaves an inaccessible temporary record, never a second accepted request.
      rmSync(temporary, { force: true });
    }
  }

  status(sessionId: string, requestId: string): TurnRecord | null {
    const record = this.read(sessionId, requestId);
    if (this.uncommitted?.sessionId === sessionId && this.uncommitted.requestId === requestId && record) {
      return { ...record, state: "interrupted", error: "sdk-turn-journal-uncommitted", needsResync: true };
    }
    if (record?.state === "accepted" && !this.active.has(record.turnId)) {
      // An accepted turn without a live run after restart is unknown/interrupted;
      // it must never be replayed automatically.
      return { ...record, state: "interrupted", needsResync: true };
    }
    return record;
  }

  projection(sessionId: string) {
    const projection = this.kernel.projection(sessionId);
    const pending = [...this.active.values()].some(({ record }) => record.sessionId === sessionId);
    return { ...projection, pending, interrupted: projection.interrupted && !pending };
  }

  async start(sessionId: string, requestId: string, text: string, deliver: (event: SdkTextEvent) => void, settled?: (turn: TurnRecord) => void): Promise<TurnRecord> {
    id(sessionId);
    id(requestId);
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 16_384) throw new Error("invalid-prompt");
    const previous = this.read(sessionId, requestId);
    const promptFingerprint = createHash("sha256").update(text, "utf8").digest("hex");
    // Older records cannot prove their original prompt and cannot be reused.
    if (previous) {
      if (previous.promptFingerprint !== promptFingerprint) throw new Error("idempotency-mismatch");
      return this.status(sessionId, requestId)!;
    }
    if (this.uncommitted) this.reconcileTerminal();
    if (this.starting || this.active.size) throw new Error("task-locked");
    this.starting = true;
    try {
      // A configured model and exact SDK session must exist before acceptance.
      await this.kernel.open(sessionId);
    } catch (error) {
      this.starting = false;
      throw error;
    }
    const record: TurnRecord = { taskId: this.taskId, sessionId, requestId, promptFingerprint, turnId: randomUUID(), state: "accepted", lastSequence: 0, needsResync: false };
    try {
      const file = this.file(sessionId, requestId);
      durableWrite(file, record, true);
      this.syncJournalDirectory(join(this.root, sessionId));
    } catch (error) {
      this.starting = false;
      // A readable record reserves the ID, but its directory sync failed and
      // no prompt was started. Never acknowledge it as an accepted turn.
      if (this.read(sessionId, requestId)) throw new Error("sdk-journal-sync-failed", { cause: error });
      throw error;
    }
    const run = (async () => {
      let result: SdkTextResult;
      try {
        result = await this.kernel.prompt(sessionId, text, (event) => {
          if (event.taskId !== this.taskId || event.sessionId !== sessionId || event.turnId !== record.turnId ||
              event.sequence !== record.lastSequence + 1) { record.needsResync = true; return; }
          record.lastSequence = event.sequence;
          try { deliver(event); } catch { record.needsResync = true; }
        }, record.turnId);
        record.state = result.state;
        if (result.error) record.error = result.error.slice(0, 256);
        if (result.error === "sdk-event-delivery-failed") record.needsResync = true;
      } catch (error) {
        record.state = "failed";
        record.error = (error instanceof Error ? error.message : String(error)).slice(0, 256);
      }
      try {
        this.finish(record);
        try { settled?.({ ...record }); }
        catch {
          record.needsResync = true;
          this.finish(record);
        }
      } catch {
        // No later model turn may start until this exact terminal record is durable.
        this.uncommitted = { ...record };
      } finally { this.active.delete(record.turnId); }
    })();
    this.active.set(record.turnId, { record, run });
    this.starting = false;
    return { ...record };
  }

  reconcileTerminal(): TurnRecord | null {
    const record = this.uncommitted;
    if (!record) return null;
    try { this.finish(record); }
    catch { throw new Error("sdk-turn-journal-uncommitted"); }
    this.uncommitted = null;
    return { ...record };
  }

  async waitForTerminal(): Promise<void> {
    await Promise.all([...this.active.values()].map(({ run }) => run));
    this.reconcileTerminal();
    this.assertTerminalCommitted();
  }

  assertTerminalCommitted(): void {
    if (this.active.size || this.starting || this.uncommitted) throw new Error("sdk-turn-journal-uncommitted");
  }

  async cancel(sessionId: string, turnId: string): Promise<TurnRecord> {
    id(sessionId);
    const active = this.active.get(turnId);
    if (!active || active.record.sessionId !== sessionId) throw new Error("sdk-turn-not-active");
    await this.kernel.cancel(sessionId);
    await active.run;
    return this.status(sessionId, active.record.requestId)!;
  }
}
