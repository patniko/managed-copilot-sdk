import { promises as fs } from "node:fs";
import { PATHS } from "../shared/constants.js";
import { run } from "./exec.js";

const PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/;

/**
 * Installs (or removes) the egress proxy's CA in the system trust store before anything else runs, so Node, Python,
 * curl, and git all verify TLS through the proxy. Never disables verification. Runs as root on every start because
 * the root filesystem is not part of the persisted state.
 */
export async function applyTrust(caCertificate: string | undefined): Promise<boolean> {
  const target = PATHS.egressCaCertificate;
  if (caCertificate === undefined || caCertificate.trim() === "") {
    const existed = await fs.access(target).then(
      () => true,
      () => false,
    );
    if (existed) {
      await fs.rm(target, { force: true });
      await updateStore();
    }
    return false;
  }
  const pem = caCertificate.trim();
  if (!PEM_CERTIFICATE.test(pem)) throw new Error("The egress CA certificate is not a single PEM certificate.");
  const current = await fs.readFile(target, "utf8").catch(() => undefined);
  if (current?.trim() !== pem) {
    await fs.writeFile(target, `${pem}\n`, { mode: 0o644 });
    await updateStore();
  }
  return true;
}

async function updateStore(): Promise<void> {
  const result = await run("update-ca-certificates", ["--fresh"], { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, cwd: "/", timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(`update-ca-certificates failed (exit ${result.exitCode}): ${result.output.slice(-500)}`);
}
