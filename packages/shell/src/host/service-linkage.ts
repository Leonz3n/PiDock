/**
 * Real link observation for [PiDock 05] (#10 box 4): the only place a
 * 「已监听」 fact can come from.
 *
 * The Host owns no port probe elsewhere — the run record's `PortsSource` stays
 * `declared` because a declared port is what the launch is SET UP to bind. This
 * module adds exactly one observation: a real TCP connect to the unit's own
 * address, bounded by a budget. `listening` is returned ONLY after the kernel
 * accepted the connection; a refused connection, a DNS/route error and the
 * budget expiring are all `not-listening`, never a missing field and never
 * inferred from "the process started". A spawn resolves before the child has
 * bound its socket, so the real probe RETRIES within the budget.
 *
 * Deliberately a plain connect, not an HTTP request: a local run unit may speak
 * any protocol, so an HTTP GET would turn a working non-HTTP dependency
 * (a DB, a gRPC server, a bare TCP echo) into a false「依赖不可达」.
 */

import { createConnection } from "node:net";

export interface ListeningAddress {
  host: string;
  port: number;
}

/** `listening` = a real connection was accepted; anything else is not a pass. */
export type ListeningObservation = "listening" | "not-listening";

export interface ServiceObservationPort {
  /** Real bounded TCP connect; never returns `listening` without an accepted connection. */
  probeListening(address: ListeningAddress, budgetMs: number): Promise<ListeningObservation>;
}

/** One connect attempt's own ceiling, so a blackholed port cannot eat the whole budget. */
const ATTEMPT_TIMEOUT_MS = 250;
const RETRY_PAUSE_MS = 50;

/**
 * Production observation: real `net.connect` attempts RETRIED until the bounded
 * budget is spent.
 *
 * A `spawn` resolves before the child has bound its socket, so a single connect
 * (or "the process started") would read a healthy unit as not listening. The
 * retry is still an observation: `listening` is returned only for an accepted
 * connection, and `not-listening` only after the whole budget produced none.
 */
export const tcpObservation: ServiceObservationPort = {
  probeListening(address, budgetMs) {
    const deadline = Date.now() + Math.max(1, budgetMs);
    return new Promise<ListeningObservation>((resolve) => {
      const attempt = (): void => {
        const socket = createConnection({ host: address.host, port: address.port });
        let settled = false;
        const next = (result: ListeningObservation): void => {
          if (settled) return;
          settled = true;
          // The socket is destroyed on every path: a probe must not leave a
          // half-open connection behind, least of all for a unit we then stop.
          socket.destroy();
          if (result === "listening") return resolve("listening");
          if (Date.now() >= deadline) return resolve("not-listening");
          setTimeout(attempt, RETRY_PAUSE_MS);
        };
        socket.setTimeout(Math.min(ATTEMPT_TIMEOUT_MS, Math.max(1, deadline - Date.now())), () => next("not-listening"));
        socket.once("connect", () => next("listening"));
        socket.once("error", () => next("not-listening"));
        socket.once("close", () => next("not-listening"));
      };
      attempt();
    });
  },
};
