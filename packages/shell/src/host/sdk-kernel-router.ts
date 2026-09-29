/**
 * Task-level SDK kernel seam ([PiDock 02m] #46).
 *
 * The task Host serves two different needs from one object:
 *
 * - **projection** must stay synchronous (the renderer-facing projection path
 *   replies with the current JSONL view), so it reads through a read-only
 *   `PiSdkTextKernel` that has no model selection and therefore can never
 *   create a session.
 * - **model operations** (open/prompt/cancel) must happen in the isolated
 *   context when the user configured a Provider, and must fail closed with
 *   `provider-not-configured` when they did not.
 *
 * `SdkTextKernelRouter` expresses exactly that: the read-only kernel answers
 * projections, and the model operations are delegated to the configured context
 * or to the same read-only kernel (which refuses them).
 */

import type { SdkTextEvent, SdkTextResult } from "./sdk-text-kernel.js";
import { PiSdkTextKernel } from "./sdk-text-kernel.js";
import type { SdkContextClient, SdkTextKernelPort } from "./sdk-context-client.js";

/** The surface `SdkTurnTransport` needs; satisfied by the kernel and by this router. */
export interface SdkTurnKernelPort extends SdkTextKernelPort {
  projection(sessionId: string): ReturnType<PiSdkTextKernel["projection"]>;
}

export class SdkTextKernelRouter implements SdkTurnKernelPort {
  constructor(
    /** Read-only kernel: projections only, never a model call. */
    private readonly reader: PiSdkTextKernel,
    /** Isolated model context, present only when a Provider is configured. */
    private context?: SdkContextClient,
  ) {}

  /** True when model calls are possible (a configured, isolated context exists). */
  get configured(): boolean {
    return this.context !== undefined;
  }

  projection(sessionId: string) {
    return this.reader.projection(sessionId);
  }

  private target(): SdkTextKernelPort {
    return this.context ?? this.reader;
  }

  open(sessionId: string) {
    return this.target().open(sessionId);
  }

  prompt(sessionId: string, text: string, deliver?: (event: SdkTextEvent) => void, issuedTurnId?: string): Promise<SdkTextResult> {
    return this.target().prompt(sessionId, text, deliver, issuedTurnId);
  }

  cancel(sessionId: string) {
    return this.target().cancel(sessionId);
  }

  /** Disposes the isolated context first (it may hold a model request), then the reader. */
  async dispose(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    try { await context?.dispose(); }
    finally { await this.reader.dispose(); }
  }
}
