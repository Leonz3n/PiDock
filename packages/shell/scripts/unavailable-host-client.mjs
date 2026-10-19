import { HostClient } from "../dist/rpc/host-client.js";

/**
 * The desktop capture scripts route task calls through their own registry and
 * must fail immediately if a shell-level Host RPC is unexpectedly reached.
 * @returns {HostClient}
 */
export function createUnavailableHostClient() {
  return new HostClient({
    postMessage() {
      throw new Error("unexpected shell-level Host RPC in desktop capture");
    },
    on() {},
  });
}
