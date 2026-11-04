/**
 * Stores Front Desk's GitHub OAuth app in the root AppHost's user secrets, for "Continue with GitHub":
 *
 *   pnpm --filter @managed-copilot/demo-front-desk setup-github
 *
 * It asks for the client ID and the client secret (typed without echo), and writes them as
 * `Parameters:front-desk-github-client-id` and `Parameters:front-desk-github-client-secret` into the file
 * `aspire secret path` names, so the secret never appears on a command line. Restart `aspire run` to use them; for
 * `aspire deploy`, see demos/front-desk/README.md.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ID_KEY = "Parameters:front-desk-github-client-id";
const SECRET_KEY = "Parameters:front-desk-github-client-secret";

function secretsFile(): string {
  const args = ["secret", "path", "--apphost", resolve(repo, "apphost.mts"), "--non-interactive"];
  try {
    let output: string;
    try {
      output = execFileSync("aspire", args, { cwd: repo, encoding: "utf8", windowsHide: true });
    } catch (error) {
      // On Windows, `aspire` may be only an npm .cmd shim, which runs through the shell.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || process.platform !== "win32") throw error;
      output = execSync(`aspire ${args.map((arg) => `"${arg}"`).join(" ")}`, { cwd: repo, encoding: "utf8", windowsHide: true });
    }
    const path = output.trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim();
    if (!path) throw new Error("aspire secret path printed nothing");
    return path;
  } catch (error) {
    throw new Error(`Couldn't find the AppHost's user secrets with \`aspire secret path\`: ${(error as Error).message.split("\n")[0]}`);
  }
}

/** The user secrets as they are now. Aspire writes the file with a byte order mark, which JSON.parse doesn't accept. */
function readSecrets(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch (error) {
    throw new Error(`The AppHost's user secrets (${file}) aren't valid JSON, so nothing was changed: ${(error as Error).message}`);
  }
}

async function ask(question: string, hidden = false): Promise<string> {
  if (!hidden) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }
  if (!stdin.isTTY) throw new Error("Run this in a terminal, so the secret can be typed without echo.");
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return await new Promise<string>((resolveAnswer, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          return resolveAnswer(value.trim());
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          stdout.write("\n");
          return reject(new Error("Cancelled."));
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

try {
  const file = secretsFile();
  // Read first: a file that can't be updated is reported before anything is typed.
  const secrets = readSecrets(file);
  console.log("Front Desk: Continue with GitHub");
  console.log(
    "Callback URLs your GitHub OAuth app (or GitHub App) needs: http://localhost:7450/auth/github/callback (plus any port offset), and https://front-desk.<environment-domain>/auth/github/callback once deployed.\n",
  );
  const clientId = await ask("Client ID: ");
  if (!/^[A-Za-z0-9._-]{10,100}$/.test(clientId)) throw new Error("That doesn't look like a GitHub client ID (for example Ov23li… or Iv23li…).");
  const clientSecret = await ask("Client secret (not shown): ", true);
  if (clientSecret.length < 20) throw new Error("That client secret looks too short. Generate one on the OAuth app's page and paste it.");
  secrets[ID_KEY] = clientId;
  secrets[SECRET_KEY] = clientSecret;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`\nSaved ${ID_KEY} and ${SECRET_KEY} in the AppHost's user secrets. Restart \`aspire run\` to use them.`);
} catch (error) {
  console.error(`\n${(error as Error).message}`);
  process.exitCode = 1;
}
