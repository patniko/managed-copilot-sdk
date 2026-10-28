import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isManagedCopilotError, ManagedCopilotError } from "@managed-copilot/protocol";
import { migrate, openDatabase, type Database } from "../../src/db.js";
import type { Authenticator, Principal } from "../../src/http.js";
import type { Logger } from "../../src/log.js";
import { GitHubAuthenticator } from "../../src/modules/core/auth.js";
import type { SchedulesService } from "../../src/modules/durable/contract.js";
import { DurableCredentials } from "../../src/modules/durable/credentials/service.js";
import { loadDurableKeys, seal, unseal } from "../../src/modules/durable/keys.js";
import { DURABLE_MIGRATIONS } from "../../src/modules/durable/migrations.js";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const ALICE: Principal = { accountId: 7, login: "alice", name: "Alice", token: "gho_alice_secret_token" };

/** GitHub stand-in: tokens map to accounts; `gate` holds verification open to stage races. */
class FakeAuth implements Authenticator {
  readonly accounts = new Map<string, Principal>([[ALICE.token, ALICE]]);
  readonly options: ({ readonly background?: boolean } | undefined)[] = [];
  readonly forgotten: string[] = [];
  calls = 0;
  gate: Promise<void> | undefined;
  async authenticate(token: string, options?: { readonly background?: boolean }): Promise<Principal> {
    this.calls++;
    this.options.push(options);
    await this.gate;
    const principal = this.accounts.get(token);
    if (!principal) throw new ManagedCopilotError("authentication_required", "Bad credentials");
    return principal;
  }
  forgetCredential(token: string): void {
    this.forgotten.push(token);
  }
}

async function expectCode(promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isManagedCopilotError(error), String(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
  if (message) expect((error as Error).message).toMatch(message);
}

describe("background credentials", () => {
  let db: Database;
  let auth: FakeAuth;
  let paused: { ownerId: number; reason: string }[];
  let synced: string[];
  let now: number;
  let credentials: DurableCredentials;
  const key = Buffer.alloc(32, 3);

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db, "durable", DURABLE_MIGRATIONS);
    auth = new FakeAuth();
    paused = [];
    synced = [];
    now = Date.parse("2026-10-24T12:00:00Z");
    const schedules = {
      pauseAllForOwner: (ownerId: number, reason: string) => {
        paused.push({ ownerId, reason });
        return 1;
      },
      syncAppHost: (account: { login: string }) => synced.push(account.login),
    } as unknown as SchedulesService;
    credentials = new DurableCredentials({ db, log: silent, sealKey: key, auth: () => auth, schedules: () => schedules, now: () => now, verifyCacheMs: 60_000 });
  });

  afterEach(() => db.close());

  it("stores the caller's own credential sealed at rest", () => {
    const status = credentials.store(ALICE);
    expect(status).toMatchObject({ account: { id: 7, login: "alice", name: "Alice" }, active: true, createdAt: "2026-10-24T12:00:00.000Z" });
    const row = db.prepare("SELECT * FROM durable_credentials").get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(ALICE.token);
    expect(String(row.sealed_token)).toMatch(/^sealed:v1:/);
    expect(credentials.has(7)).toBe(true);
    expect(synced).toEqual(["alice"]);
  });

  it("verifies as background work and has core forget every credential it removes", async () => {
    credentials.store(ALICE);
    now += 120_000;
    await credentials.principalFor(7);
    expect(auth.options).toEqual([{ background: true }]);
    // A new sign-in replaces the old credential; logout removes the new one.
    const renewed = { ...ALICE, token: "gho_alice_renewed" };
    auth.accounts.set(renewed.token, renewed);
    credentials.store(renewed);
    credentials.store(renewed);
    credentials.revoke(renewed);
    expect(auth.forgotten).toEqual([ALICE.token, renewed.token]);
  });

  it("has core forget a credential GitHub rejects", async () => {
    credentials.store(ALICE);
    auth.accounts.delete(ALICE.token);
    now += 120_000;
    await expectCode(credentials.principalFor(7), "authentication_required");
    expect(auth.forgotten).toEqual([ALICE.token]);
  });

  it("binds sealed values to their account and detects tampering", () => {
    const sealed = seal(key, "secret", "account-1");
    expect(unseal(key, sealed, "account-1")).toBe("secret");
    expect(() => unseal(key, sealed, "account-2")).toThrow(/could not be unsealed/);
    expect(() => unseal(Buffer.alloc(32, 9), sealed, "account-1")).toThrow(/could not be unsealed/);
  });

  it("re-verifies the credential with GitHub on use and reuses a recent verification", async () => {
    credentials.store(ALICE);
    now += 120_000;
    expect(await credentials.principalFor(7)).toEqual(ALICE);
    expect(await credentials.principalFor(7)).toEqual(ALICE);
    expect(auth.calls).toBe(1);
    now += 61_000;
    await credentials.principalFor(7);
    expect(auth.calls).toBe(2);
    expect(credentials.status(ALICE).lastVerifiedAt).toBe(new Date(now).toISOString());
  });

  it("explains a missing sign-in", async () => {
    expect(credentials.status(ALICE)).toMatchObject({ active: false, reason: expect.stringMatching(/npx managed-copilot login/) });
    await expectCode(credentials.principalFor(7), "authentication_required", /npx managed-copilot login/);
  });

  it("invalidates a credential GitHub rejects and pauses the owner's schedules", async () => {
    credentials.store(ALICE);
    now += 120_000;
    auth.accounts.clear();
    await expectCode(credentials.principalFor(7), "authentication_required", /no longer valid/);
    expect(credentials.has(7)).toBe(false);
    expect(credentials.status(ALICE)).toMatchObject({ active: false, reason: expect.stringMatching(/revoked or expired/) });
    expect(paused).toEqual([{ ownerId: 7, reason: expect.stringMatching(/^Paused: /) }]);
  });

  it("never runs one account's work as another account", async () => {
    credentials.store(ALICE);
    now += 120_000;
    auth.accounts.set(ALICE.token, { accountId: 8, login: "mallory", token: ALICE.token });
    await expectCode(credentials.principalFor(7), "authentication_required", /different account/);
    expect(credentials.has(7)).toBe(false);
  });

  it("revokes on logout, pausing schedules with a visible reason", async () => {
    credentials.store(ALICE);
    credentials.revoke(ALICE);
    expect(credentials.status(ALICE)).toMatchObject({ active: false, reason: "Signed out with `managed-copilot logout`." });
    expect(paused).toEqual([{ ownerId: 7, reason: "Paused: Signed out with `managed-copilot logout`." }]);
    await expectCode(credentials.principalFor(7), "authentication_required");
  });

  it("does not hand out a credential that was signed out while GitHub was verifying it", async () => {
    credentials.store(ALICE);
    now += 120_000;
    let release!: () => void;
    auth.gate = new Promise<void>((done) => (release = done));
    const pending = credentials.principalFor(7);
    credentials.revoke(ALICE);
    release();
    await expectCode(pending, "authentication_required", /changed while it was being verified/);
    expect(credentials.has(7)).toBe(false);
  });

  it("keeps its sealing key across restarts and derives separate keys per purpose", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-durable-keys-"));
    try {
      const first = loadDurableKeys(dir, {});
      const second = loadDurableKeys(dir, {});
      expect(second.seal.equals(first.seal)).toBe(true);
      expect(first.seal.equals(first.capability)).toBe(false);
      const configured = Buffer.alloc(32, 1).toString("base64");
      // Nothing sealed yet: the configured key is used, as before.
      expect(loadDurableKeys(dir, { MANAGED_COPILOT_DURABLE_KEY: configured }).seal.equals(first.seal)).toBe(false);
      // A stored credential sealed under the file key: the file key is wrapped and kept for this deployment.
      const sealed = [{ value: seal(first.seal, "gho_token", "ctx"), context: "ctx" }];
      const adopted = loadDurableKeys(dir, { MANAGED_COPILOT_DURABLE_KEY: configured }, { sealed: () => sealed, stamp: "1" });
      expect(unseal(adopted.seal, sealed[0]!.value, "ctx")).toBe("gho_token");
      expect(adopted.capability.equals(first.capability)).toBe(true);
      expect(existsSync(join(dir, "durable.key"))).toBe(true);
      expect(loadDurableKeys(dir, { MANAGED_COPILOT_DURABLE_KEY: configured }, { sealed: () => sealed, stamp: "2" }).seal.equals(first.seal)).toBe(true);
      expect(existsSync(join(dir, "durable.key"))).toBe(false);
      expect(() => loadDurableKeys(dir, {})).toThrow(/wrapped under a configured key/);
      expect(() => loadDurableKeys(dir, { MANAGED_COPILOT_DURABLE_KEY: Buffer.alloc(32, 2).toString("base64") })).toThrow(/does not open/);
      expect(() => loadDurableKeys(dir, { MANAGED_COPILOT_DURABLE_KEY: "short" })).toThrow(/32 bytes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Core's authenticator learns background verification and forgetCredential in its incarnation batch; until that is
  // on this branch, these run against FakeAuth above only.
  const coreSupportsBackground = typeof (GitHubAuthenticator.prototype as { forgetCredential?: unknown }).forgetCredential === "function";

  it.skipIf(!coreSupportsBackground)("with core's GitHub authenticator, never makes a background verification the live credential, and logout drops it", async () => {
    const users = new Map<string, unknown>([
      [ALICE.token, { id: 7, login: "alice", name: "Alice" }],
      ["gho_alice_app", { id: 7, login: "alice", name: "Alice" }],
    ]);
    // GitHub's REST API stand-in: GET /user resolves a token to its account.
    const github = new GitHubAuthenticator({
      apiUrl: "https://github.invalid/api",
      log: silent,
      retryDelaysMs: [],
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const token = (new Headers(init?.headers).get("authorization") ?? "").replace(/^(bearer|token)\s+/i, "");
        const user = users.get(token);
        if (!url.endsWith("/user")) return new Response(null, { status: 404 });
        return user ? Response.json(user) : Response.json({ message: "Bad credentials" }, { status: 401 });
      }) as typeof fetch,
    });
    const schedules = { pauseAllForOwner: () => 0, syncAppHost: () => undefined } as unknown as SchedulesService;
    const real = new DurableCredentials({ db, log: silent, sealKey: key, auth: () => github, schedules: () => schedules, now: () => now, verifyCacheMs: 60_000 });
    real.store(ALICE);
    expect(await real.principalFor(7)).toMatchObject({ accountId: 7, login: "alice" });
    expect(github.liveCredential(7)).toBeUndefined();
    // The owner's CLI presents the same token: it is the live credential until logout removes it.
    await github.authenticate(ALICE.token);
    expect(github.liveCredential(7)?.token).toBe(ALICE.token);
    real.revoke(ALICE);
    expect(github.liveCredential(7)).toBeUndefined();
    // A connected app's own token is not the background credential, so logout leaves it alone.
    await github.authenticate("gho_alice_app");
    real.store(ALICE);
    real.revoke(ALICE);
    expect(github.liveCredential(7)?.token).toBe("gho_alice_app");
  });
});
