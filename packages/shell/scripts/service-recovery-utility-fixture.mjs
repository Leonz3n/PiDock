// Metadata relay only: no filesystem, executor, SDK or production RPC imports.
const parent = process.parentPort;
if (!parent) throw Error("recovery fixture requires utilityProcess parent port");
const pending = new Set();
parent.on("message", ({ data }) => {
  if (data?.kind === "command") {
    if (pending.has(data.id)) throw Error("duplicate fixture command");
    pending.add(data.id);
    parent.postMessage({ kind: "checkpoint-request", id: data.id, packet: data.packet });
  } else if (data?.kind === "checkpoint-result" && pending.delete(data.id)) {
    parent.postMessage({ kind: "command-complete", id: data.id, response: data.response });
  }
});
parent.postMessage({ kind: "ready", versions: { electron: process.versions.electron, node: process.versions.node } });
