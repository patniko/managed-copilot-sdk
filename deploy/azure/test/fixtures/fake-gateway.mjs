// A stand-in gateway for supervisor tests: answers /healthz with its pid and lease generation.
// FAKE_GATEWAY_EXIT_AFTER_MS / FAKE_GATEWAY_EXIT_CODE make it exit by itself; FAKE_GATEWAY_IGNORE_SIGTERM=1 makes it
// ignore SIGTERM (POSIX only) so the supervisor has to escalate to SIGKILL; FAKE_GATEWAY_STOP_DELAY_MS delays its
// exit after SIGTERM (POSIX only); FAKE_GATEWAY_SPAWN_CHILD=1 starts a long-running child (like the gateway's shared
// runtime) and reports its pid as `descendant`.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const port = Number(process.env.PORT);
const descendant =
  process.env.FAKE_GATEWAY_SPAWN_CHILD === "1" ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid : undefined;
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify({ status: "gateway", pid: process.pid, descendant, generation: process.env.MANAGED_COPILOT_LEASE_GENERATION, path: req.url }));
});
server.listen(port, "127.0.0.1");

process.on("SIGTERM", () => {
  if (process.env.FAKE_GATEWAY_IGNORE_SIGTERM === "1") return;
  setTimeout(() => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  }, Number(process.env.FAKE_GATEWAY_STOP_DELAY_MS ?? 0));
});

const exitAfter = Number(process.env.FAKE_GATEWAY_EXIT_AFTER_MS ?? 0);
if (exitAfter > 0) setTimeout(() => process.exit(Number(process.env.FAKE_GATEWAY_EXIT_CODE ?? 0)), exitAfter);
