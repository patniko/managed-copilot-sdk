// Probe: can the stock runtime (SDK 1.0.26, runtime 1.0.103) send a session's model calls to Azure AI Foundry with an
// Entra token, holding no GitHub credential at all? Two placements, as the gateway runs them:
//
//   shared   The runtime asks its client for each request's bearer token (`providerToken.getToken`): the gateway
//            answers with an Entra token from its own Azure identity.
//   sandbox  The runtime holds only a placeholder and sends every model request to its client (`llmInference.*`):
//            the gateway swaps the placeholder for the Entra token and makes the call itself.
//
// Each case runs a fresh runtime process with an empty COPILOT_HOME, no GitHub variables, and `--no-auto-login`, then
// resumes the session in a second process. Needs `pnpm install`, `az login`, and a Foundry deployment you can call:
//
//   $env:FOUNDRY_ENDPOINT = "https://<account>.openai.azure.com/openai/v1"; $env:FOUNDRY_MODEL = "<deployment>"
//   $env:AZURE_SUBSCRIPTION = "<subscription id>"   # optional: the subscription whose tenant issues the token
//   node docs/design/probes/foundry-inference.mjs
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const root = new URL("../../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const sdk = await import(pathToFileURL(root + "/libraries/sdk/node_modules/@github/copilot-sdk/dist/index.js").href);
const ENDPOINT = (process.env.FOUNDRY_ENDPOINT ?? "https://mc-foundry-dev.openai.azure.com/openai/v1").replace(/\/+$/, "");
const MODEL = process.env.FOUNDRY_MODEL ?? "grok-4.7";
const PLACEHOLDER = "mcft_probe_placeholder";

async function entraToken() {
  const args = ["account", "get-access-token", "--resource", "https://cognitiveservices.azure.com", "--query", "accessToken", "-o", "tsv"];
  if (process.env.AZURE_SUBSCRIPTION) args.push("--subscription", process.env.AZURE_SUBSCRIPTION);
  const { stdout } = await promisify(execFile)("az", args, { shell: process.platform === "win32", windowsHide: true });
  return stdout.trim();
}

/** What the gateway gives its runtimes: OS variables only, a private COPILOT_HOME, no tokens. */
function cleanEnv(home) {
  const keep = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "SystemDrive", "TEMP", "TMP", "TMPDIR", "LANG", "TZ", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS"];
  const env = Object.fromEntries(keep.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  return { ...env, HOME: home, USERPROFILE: home, COPILOT_DISABLE_KEYTAR: "1", COPILOT_AUTO_UPDATE: "false", NO_COLOR: "1" };
}

/** Every file under `dir` that mentions `needle`. */
function filesContaining(dir, needle) {
  const hits = [];
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.size < 64 * 1024 * 1024 && readFileSync(full).includes(needle)) hits.push(full.slice(dir.length + 1));
    }
  };
  walk(dir);
  return hits;
}

const weather = sdk.defineTool("get_weather", {
  description: "Current weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  skipPermission: true,
  handler: async ({ city }) => `${city}: 18°C, light rain`,
});

class Broker extends sdk.CopilotRequestHandler {
  constructor(token) {
    super();
    this.token = token;
    this.seen = [];
  }
  async sendRequest(request, ctx) {
    const url = new URL(ctx.url);
    const auth = request.headers.get("authorization") ?? "";
    this.seen.push({ host: url.host, path: url.pathname, placeholder: auth === `Bearer ${PLACEHOLDER}` });
    if (`${url.origin}${url.pathname}`.indexOf(ENDPOINT) !== 0 || auth !== `Bearer ${PLACEHOLDER}`) return new Response("refused", { status: 403 });
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    return fetch(ctx.url, { method: request.method, headers, body: request.body, duplex: "half", signal: ctx.signal });
  }
}

const step = (placement, message) => process.stderr.write(`[${placement}] ${message}\n`);
const within = (ms, promise, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish in ${ms / 1000} s`)), ms).unref())]);
const watch = (placement, session) =>
  session.on((event) => {
    if (event.type.endsWith("_delta") || event.type === "session.usage_checkpoint") return;
    const detail = event.type === "session.error" ? ` ${JSON.stringify(event.data).slice(0, 400)}` : event.type === "model.call_failure" ? ` ${JSON.stringify(event.data).slice(0, 400)}` : "";
    step(placement, `event ${event.type}${detail}`);
  });

async function run(placement, token) {
  const home = mkdtempSync(join(tmpdir(), `mc-foundry-${placement}-`));
  const results = { placement, providerTokenCalls: 0 };
  const broker = placement === "sandbox" ? new Broker(token) : undefined;
  const provider = () => ({
    type: "openai",
    baseUrl: ENDPOINT,
    wireApi: "completions",
    wireModel: MODEL,
    ...(placement === "sandbox"
      ? { bearerToken: PLACEHOLDER }
      : {
          bearerTokenProvider: async () => {
            results.providerTokenCalls++;
            return token;
          },
        }),
  });
  const open = () =>
    new sdk.CopilotClient({ baseDirectory: join(home, "copilot-home"), cwd: home, env: cleanEnv(home), useLoggedInUser: false, ...(broker ? { requestHandler: broker } : {}) });
  let client;
  try {
    client = open();
    step(placement, "starting runtime");
    await within(60_000, client.start(), "start");
    step(placement, "creating session");
    const session = await within(60_000, client.createSession({ model: MODEL, provider: provider(), tools: [weather], onPermissionRequest: sdk.approveAll }), "createSession");
    watch(placement, session);
    step(placement, `sending (session ${session.sessionId})`);
    const first = await session.sendAndWait({ prompt: "Call get_weather for Paris, then answer in one short sentence." }, 180_000);
    results.firstReply = first?.data.content;
    results.toolCalled = (await session.getEvents()).some((event) => event.type === "tool.execution_start" && event.data.toolName === "get_weather");
    const id = session.sessionId;
    step(placement, "stopping the first runtime");
    await within(30_000, client.stop(), "stop");

    client = open();
    step(placement, "starting a second runtime");
    await within(60_000, client.start(), "start");
    step(placement, "resuming");
    const resumed = await within(60_000, client.resumeSession(id, { provider: provider(), tools: [weather], onPermissionRequest: sdk.approveAll }), "resumeSession");
    watch(placement, resumed);
    step(placement, "sending to the resumed session");
    const second = await resumed.sendAndWait({ prompt: "Which city did I ask about? One word." }, 180_000);
    results.resumedReply = second?.data.content;
    step(placement, "stopping the second runtime");
    await within(30_000, client.stop(), "stop");
    client = undefined;

    if (broker) results.brokered = broker.seen;
    results.tokenInState = filesContaining(join(home, "copilot-home"), token.slice(-24));
    results.placeholderInState = placement === "sandbox" ? filesContaining(join(home, "copilot-home"), PLACEHOLDER).length : undefined;
  } catch (error) {
    results.error = error instanceof Error ? error.message : String(error);
    await client?.forceStop().catch(() => undefined);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
  return results;
}

const token = await entraToken();
for (const placement of ["shared", "sandbox"]) console.log(JSON.stringify(await run(placement, token), null, 2));
