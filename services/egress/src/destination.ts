/**
 * Destination checks for every request path. The decision logic lives in `@managed-copilot/protocol`
 * (`evaluateDestination`) so the proxy and gateway-side fetches apply identical rules; this module adds the system
 * resolver and a dialer that connects only to validated addresses.
 */
import { lookup } from "node:dns/promises";
import { connect, type Socket } from "node:net";
import { evaluateDestination, isUnresolvableName, type DestinationCheckOptions, type DestinationDecision, type DestinationResolver } from "@managed-copilot/protocol";

export { evaluateDestination };
export type DestinationOptions = DestinationCheckOptions;
export type Decision = DestinationDecision;
export type Resolver = DestinationResolver;
export type Dialer = (address: string, port: number) => Socket;

export const systemResolver: Resolver = async (host) => {
  if (isUnresolvableName(host)) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
};

export const systemDialer: Dialer = (address, port) => connect({ host: address, port });

/** Connects to the first reachable validated address. Never resolves names. */
export function dialValidated(addresses: readonly string[], port: number, dial: Dialer, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let index = 0;
    let lastError: Error | undefined;
    const attempt = () => {
      const address = addresses[index++];
      if (address === undefined) {
        reject(lastError ?? new Error("No address to connect to"));
        return;
      }
      const socket = dial(address, port);
      const timer = setTimeout(() => socket.destroy(new Error(`Connection to ${address}:${port} timed out`)), timeoutMs);
      const onError = (error: Error) => {
        clearTimeout(timer);
        lastError = error;
        socket.destroy();
        attempt();
      };
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", onError);
        // Keep the process alive if the socket errors before the caller attaches its own handlers.
        socket.on("error", () => undefined);
        resolve(socket);
      });
      socket.once("error", onError);
    };
    attempt();
  });
}
