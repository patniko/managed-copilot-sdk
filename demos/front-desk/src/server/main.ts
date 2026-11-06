import { createServer } from "node:http";
import { join } from "node:path";
import { EmailAccounts } from "./auth/email.js";
import { GitHubAuth } from "./auth/github.js";
import { RateLimiter } from "./auth/ratelimit.js";
import { loadConfig } from "./config.js";
import { Conversations } from "./conversations.js";
import { Hub } from "./hub.js";
import { createRequestHandler, type Middleware } from "./http.js";
import { log } from "./log.js";
import { People } from "./people.js";
import { ManagedPlatform } from "./platform.js";
import { loadOrCreateDevSealingKey, Sealer } from "./seal.js";
import { Store } from "./store.js";

const config = loadConfig();
const store = new Store(join(config.dataDir, "front-desk.db"));
const sealer = Sealer.fromSecret(config.sealingKey ?? loadOrCreateDevSealingKey(config.dataDir));
const limiter = new RateLimiter();
// With an app key (from the AppHost's `apps`), Front Desk connects as itself and acts for each person; otherwise it
// connects as each GitHub user. It never reads a GitHub token from this server's environment.
const platform = new ManagedPlatform({ config, ...(process.env.MANAGED_COPILOT_APP_KEY ? { appKey: process.env.MANAGED_COPILOT_APP_KEY } : {}) });
platform.start();
const github = new GitHubAuth({ config, store, sealer });
const email = new EmailAccounts(store, limiter, config.inviteCode);
const people = new People(store, github, config);
const hub = new Hub();
const conversations = new Conversations({
  store,
  platform,
  people,
  hub,
  config,
  onSignInExpired: (userId) => {
    // GitHub stopped accepting their token: they sign in again from the start.
    github.forget(userId);
    store.deleteBrowserSessionsOf(userId);
    hub.disconnect(userId);
  },
});

const server = createServer();
let ui: Middleware | undefined;
if (config.dev) {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({ configFile: join(config.packageRoot, "vite.config.ts"), server: { middlewareMode: true, hmr: { server } }, appType: "spa" });
  ui = vite.middlewares as unknown as Middleware;
}
server.on("request", createRequestHandler({ config, store, people, github, email, conversations, hub, limiter, platform }, ui));

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, config.host, () => resolve());
}).catch((error: NodeJS.ErrnoException) => {
  log.error(error.code === "EADDRINUSE" ? `Port ${config.port} is already in use. Set PORT to use another port.` : `Couldn't start: ${error.message}`);
  process.exit(1);
});

const accounts = store.countUsers();
log.info(`Front Desk: ${config.publicUrl}${config.dev ? " (dev)" : ""}`, {
  environment: config.environment,
  githubSignIn: github.configured ? "on" : "off",
  localGitHubSignIn: config.localGitHubSignIn ? "on" : "off",
  accounts: `${accounts.github} GitHub, ${accounts.email} email`,
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("Shutting down; conversations keep running on Managed Copilot", { signal });
  hub.close();
  await conversations.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown(signal));
