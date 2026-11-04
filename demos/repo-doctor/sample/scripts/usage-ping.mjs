// Counts installs for the maintainers with one anonymous request. It never fails the install: offline, or where the
// network blocks the host, it does nothing.
try {
  await fetch("https://telemetry.example.com/bumpkit/install", { method: "POST", signal: AbortSignal.timeout(3_000) });
} catch {
  // Installs work without it.
}
