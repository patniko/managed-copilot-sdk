/** Password hashing for email accounts: scrypt with a per-password salt, compared in constant time. */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { AppError } from "./errors.js";

const PARAMS = { N: 32_768, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const MAX_MEMORY = 128 * 1024 * 1024;
/**
 * scrypt runs on Node's small shared thread pool, which file reads and DNS lookups need too: at most two hashes run at
 * once, and a flood of sign-ins waits in a short line instead of starving everything else.
 */
const MAX_RUNNING = 2;
const MAX_WAITING = 64;
let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running < MAX_RUNNING) running++;
  else {
    if (waiting.length >= MAX_WAITING) throw new AppError("busy", "Front Desk is busy signing people in. Try again in a moment.", 503);
    // A finishing hash hands its slot straight to the next one in line.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: MAX_MEMORY };
  return withSlot(
    () =>
      new Promise((resolve, reject) => {
        scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, options, (error, key) => (error ? reject(error) : resolve(key)));
      }),
  );
}

/** `scrypt$N$r$p$<salt>$<hash>`, both base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltText, hashText] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64url");
  const actual = await derive(password, Buffer.from(saltText, "base64url"), { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A real hash of nothing in particular, verified when an email is unknown so both answers take as long. */
let decoy: Promise<string> | undefined;
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(18).toString("base64url"));
  return decoy;
}
