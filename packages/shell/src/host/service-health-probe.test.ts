/**
 * [PiDock 04] (#7 box 5) the declared 健康检查, really probed.
 *
 * Every case here runs against REAL local sockets: an http/tcp listener this
 * file binds on 127.0.0.1 and counts connections on, so the assertions are
 * about what the probe really dialled and really observed - never about a
 * stubbed transport. Three of the invariants cannot be shown any other way:
 * "no probe without a running process" and "only the declared target" are
 * proven by a listener that stays at ZERO connections, and "bounded, one
 * attempt" by a target that accepts the connection and then answers nothing
 * (the read must still come back, and the listener must see exactly one
 * connection - a retry would show as a second).
 *
 * No test in this file starts, stops or restarts anything: the probe is a read.
 */

import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SERVICE_HEALTH_PROBE_BOUND_MS, probeServiceHealth, unprobedServiceHealth } from "./service-health-probe.js";

/** A real listener on 127.0.0.1 with a connection counter, closed after every test. */
interface Listener {
  readonly port: number;
  /** How many connections this listener really accepted. */
  readonly connections: number;
  close(): Promise<void>;
}

const open: Listener[] = [];
afterEach(async () => {
  for (const listener of open.splice(0).reverse()) await listener.close();
});

function track(listener: Listener): Listener {
  open.push(listener);
  return listener;
}

/** A real HTTP listener; `handler` decides what it answers (and whether it answers at all). */
async function httpListener(handler: (response: ServerResponse) => void, onRequest?: () => void): Promise<Listener> {
  const server = createHttpServer((_request, response) => {
    onRequest?.();
    handler(response);
  });
  const sockets = new Set<Socket>();
  let connections = 0;
  server.on("connection", (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  // A client that destroys its request mid-response is normal here (the probe
  // reads the status line and hangs up); it must not surface as an unhandled
  // server error.
  server.on("clientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no-bound-port");
  return track({
    port: address.port,
    get connections() { return connections; },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

/** A real TCP listener; it answers by accepting the connection (that IS a tcp check's observation). */
async function tcpListener(): Promise<Listener> {
  const server = createTcpServer((socket) => { socket.on("error", () => {}); });
  const sockets = new Set<Socket>();
  let connections = 0;
  server.on("connection", (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no-bound-port");
  return track({
    port: address.port,
    get connections() { return connections; },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

/** A port that was really bound and is now closed: a connection there is really refused. */
async function closedPort(): Promise<number> {
  const listener = await tcpListener();
  const port = listener.port;
  await listener.close();
  open.splice(open.indexOf(listener), 1);
  return port;
}

/** A low bound, so the hanging-target case costs a few hundred milliseconds, not the production one. */
const TEST_BOUND_MS = 250;

/**
 * Wait (bounded) until a listener has really accepted `expected` connections:
 * an accepted socket is observed on the server side a tick after the client's
 * connect resolves (and a tcp probe hangs up as soon as it has connected), so a
 * zero read here would be a race, not a missing connection.
 */
async function untilConnections(listener: Listener, expected: number): Promise<void> {
  for (let elapsed = 0; elapsed < 1000 && listener.connections < expected; elapsed += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("[PiDock 04] #7 a declared health check is really probed, boundedly", () => {
  it("reports a real HTTP listener as healthy with its real status code and elapsed time", async () => {
    const listener = await httpListener((response) => { response.writeHead(200, { "content-type": "text/plain" }); response.end("ok"); });
    const target = `http://127.0.0.1:${String(listener.port)}/health`;
    const observation = await probeServiceHealth({ healthCheck: { kind: "http", target }, running: true });
    expect(observation).toMatchObject({ state: "healthy", kind: "http", target, statusCode: 200, boundMs: SERVICE_HEALTH_PROBE_BOUND_MS });
    expect(observation.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(observation.elapsedMs).toBeLessThanOrEqual(SERVICE_HEALTH_PROBE_BOUND_MS);
    // A pass states the facts and invents no reason.
    expect(observation.reason).toBeUndefined();
    expect(listener.connections).toBe(1);
  });

  it("reports a closed declared port as unhealthy, by name, with the real attempt's duration", async () => {
    const port = await closedPort();
    const target = `http://127.0.0.1:${String(port)}/health`;
    const observation = await probeServiceHealth({ healthCheck: { kind: "http", target }, running: true });
    expect(observation).toMatchObject({ state: "unhealthy", kind: "http", target, reason: "连接被拒" });
    expect(observation.statusCode).toBeUndefined();
    expect(observation.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(observation.boundMs).toBe(SERVICE_HEALTH_PROBE_BOUND_MS);
  });

  it("gives up at the bound against a target that accepts and never answers, with ONE attempt", async () => {
    // `onRequest` never fires: the server is handed the connection and answers
    // nothing at all.
    const listener = await httpListener(() => { /* never responds */ });
    const target = `http://127.0.0.1:${String(listener.port)}/health`;
    const startedAt = Date.now();
    const observation = await probeServiceHealth({ healthCheck: { kind: "http", target }, running: true, boundMs: TEST_BOUND_MS });
    const wallMs = Date.now() - startedAt;
    expect(observation.state).toBe("unhealthy");
    expect(observation.reason).toContain("探测超时");
    expect(observation.reason).toContain(`${String(TEST_BOUND_MS)}ms`);
    // The read came back at the bound (not at the test timeout), and it really
    // waited for the bound rather than failing instantly for another reason.
    expect(wallMs).toBeLessThan(TEST_BOUND_MS + 750);
    expect(observation.elapsedMs).toBeGreaterThanOrEqual(TEST_BOUND_MS - 50);
    // One attempt: a retry would open a second connection.
    expect(listener.connections).toBe(1);
  });

  it("reports a redirect as itself instead of following it off the declared target", async () => {
    const destination = await httpListener((response) => { response.writeHead(200); response.end("followed"); });
    const listener = await httpListener((response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${String(destination.port)}/health` });
      response.end();
    });
    const target = `http://127.0.0.1:${String(listener.port)}/health`;
    const observation = await probeServiceHealth({ healthCheck: { kind: "http", target }, running: true });
    expect(observation).toMatchObject({ state: "unhealthy", statusCode: 302 });
    expect(observation.reason).toContain("重定向未跟随");
    // The undeclared host was never dialled: following a redirect would have
    // probed an address the pinned revision does not declare.
    expect(destination.connections).toBe(0);
  });

  it("never reads a response body: a 2xx answers from its status line even with a giant stalled body", async () => {
    const listener = await httpListener((response) => {
      // A declared target that promises 100 MiB and then stalls forever.
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(100 * 1024 * 1024) });
      response.write("x".repeat(4096));
    });
    const target = `http://127.0.0.1:${String(listener.port)}/health`;
    const startedAt = Date.now();
    const observation = await probeServiceHealth({ healthCheck: { kind: "http", target }, running: true, boundMs: TEST_BOUND_MS });
    expect(observation).toMatchObject({ state: "healthy", statusCode: 200 });
    // The answer came from the status line, not from waiting for the body.
    expect(Date.now() - startedAt).toBeLessThan(TEST_BOUND_MS);
  });

  it("never probes when the pinned revision declares no check", async () => {
    const listener = await httpListener((response) => { response.writeHead(200); response.end(); });
    // The listener exists and is reachable, and is NOT the target of anything:
    // 未声明 is about the revision, not about reachability.
    expect(await probeServiceHealth({ running: true })).toEqual({ state: "undeclared" });
    expect(await probeServiceHealth({ running: false })).toEqual({ state: "undeclared" });
    expect(listener.connections).toBe(0);
  });

  it("never dials a service that is not running", async () => {
    const listener = await httpListener((response) => { response.writeHead(200); response.end(); });
    const tcp = await tcpListener();
    const target = `http://127.0.0.1:${String(listener.port)}/health`;
    const observation = await probeServiceHealth({ healthCheck: { kind: "http", target }, running: false });
    expect(observation.state).toBe("not-probed");
    expect(observation.reason).toContain("服务未运行");
    expect(observation.elapsedMs).toBeUndefined();
    expect(observation.boundMs).toBeUndefined();
    expect(listener.connections).toBe(0);
    // The same holds for a tcp check: nothing is dialled either.
    const tcpObservation = await probeServiceHealth({ healthCheck: { kind: "tcp", target: `127.0.0.1:${String(tcp.port)}` }, running: false });
    expect(tcpObservation.state).toBe("not-probed");
    expect(tcp.connections).toBe(0);
  });

  it("names gRPC as not implemented here instead of reporting healthy or a silent no-result", async () => {
    const tcp = await tcpListener();
    const observation = await probeServiceHealth({ healthCheck: { kind: "grpc", target: `127.0.0.1:${String(tcp.port)}` }, running: true });
    expect(observation.state).toBe("not-probed");
    expect(observation.kind).toBe("grpc");
    expect(observation.reason).toContain("gRPC");
    expect(observation.state).not.toBe("healthy");
    // The named state is not a silent one: it carries a reason and dialled nothing.
    expect(observation.reason).toBeDefined();
    expect(observation.elapsedMs).toBeUndefined();
    expect(tcp.connections).toBe(0);
  });

  it("probes only the DECLARED target: a healthy neighbour on another port is never dialled", async () => {
    const declared = await httpListener((response) => { response.writeHead(200); response.end("declared"); });
    const neighbour = await httpListener((response) => { response.writeHead(500); response.end("neighbour"); });
    const target = `http://127.0.0.1:${String(declared.port)}/health`;
    const observation = await probeServiceHealth({ healthCheck: { kind: "http", target }, running: true });
    expect(observation).toMatchObject({ state: "healthy", statusCode: 200, target });
    expect(observation.target).toContain(`:${String(declared.port)}`);
    expect(declared.connections).toBe(1);
    expect(neighbour.connections).toBe(0);
  });

  it("names a declared target it cannot probe instead of guessing one", async () => {
    expect(await probeServiceHealth({ healthCheck: { kind: "http" }, running: true }))
      .toMatchObject({ state: "not-probed", kind: "http", reason: "健康检查未声明目标地址，不发起探测" });
    expect(await probeServiceHealth({ healthCheck: { kind: "http", target: "not a url" }, running: true }))
      .toMatchObject({ state: "not-probed", reason: "健康检查目标不是可解析的地址，不发起探测" });
    expect(await probeServiceHealth({ healthCheck: { kind: "http", target: "https://127.0.0.1:1/health" }, running: true }))
      .toMatchObject({ state: "not-probed", reason: "健康检查目标协议 https: 尚未接入探测（本机只探测 http/tcp）" });
    expect(await probeServiceHealth({ healthCheck: { kind: "tcp", target: "127.0.0.1" }, running: true }))
      .toMatchObject({ state: "not-probed", reason: "健康检查目标不是 host:port 形式，不发起探测" });
    // Every one of them is a named non-pass: never a silent `not-probed`.
    for (const observation of [
      await probeServiceHealth({ healthCheck: { kind: "http" }, running: true }),
      await probeServiceHealth({ healthCheck: { kind: "tcp", target: "127.0.0.1" }, running: true }),
    ]) {
      expect(observation.elapsedMs).toBeUndefined();
      expect(observation.reason).toBeDefined();
    }
  });

  it("probes a declared tcp socket for real and names a refused one", async () => {
    const listener = await tcpListener();
    const healthy = await probeServiceHealth({ healthCheck: { kind: "tcp", target: `127.0.0.1:${String(listener.port)}` }, running: true });
    expect(healthy).toMatchObject({ state: "healthy", kind: "tcp", boundMs: SERVICE_HEALTH_PROBE_BOUND_MS });
    expect(healthy.elapsedMs).toBeGreaterThanOrEqual(0);
    await untilConnections(listener, 1);
    expect(listener.connections).toBe(1);
    const port = await closedPort();
    const refused = await probeServiceHealth({ healthCheck: { kind: "tcp", target: `127.0.0.1:${String(port)}` }, running: true });
    expect(refused).toMatchObject({ state: "unhealthy", kind: "tcp", reason: "连接被拒" });
  });

  it("states an unprobed read as unprobed, and never as a pass", () => {
    expect(unprobedServiceHealth(undefined)).toEqual({ state: "undeclared" });
    expect(unprobedServiceHealth({ kind: "http", target: "http://127.0.0.1:3000/health" }))
      .toEqual({ state: "not-probed", kind: "http", target: "http://127.0.0.1:3000/health", reason: "本次读取未执行探测（读取方未提供探测结果）" });
    // The production bound stays inside the slice's stated ceiling.
    expect(SERVICE_HEALTH_PROBE_BOUND_MS).toBeLessThanOrEqual(2000);
  });
});
