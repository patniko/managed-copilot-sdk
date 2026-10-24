import type { SessionEvent } from "@github/copilot-sdk";
import { ManagedCopilotError, type AccountInfo } from "@managed-copilot/sdk";
import { describe, expect, it } from "vitest";
import type { BackgroundView } from "../src/shared/protocol.js";
import { BACKGROUND_ROUTE, BackgroundWork } from "../src/server/background.js";
import { backgroundReason, isBackgroundWorkError, pausedReasonText } from "../src/server/describe.js";
import { createLogger } from "../src/server/log.js";
import { resolveGitHubToken } from "../src/server/platform.js";
import { Timeline } from "../src/server/timeline.js";

const OCTO: AccountInfo = { id: 1, login: "octo" };

/** A platform whose background route answers from `handler`; requests can be held to test overlapping reads. */
function fakePlatform(handler: (method: string, path: string) => Promise<unknown>) {
  const calls: string[] = [];
  return {
    calls,
    platform: {
      managed: { account: OCTO } as { account: AccountInfo } | undefined,
      async request<T>(method: "GET" | "POST" | "DELETE", path: string): Promise<T> {
        calls.push(`${method} ${path}`);
        return (await handler(method, path)) as T;
      },
    },
  };
}

function setup(handler: (method: string, path: string) => Promise<unknown>, now = { value: 1_000_000 }) {
  const { platform, calls } = fakePlatform(handler);
  const changes: BackgroundView[] = [];
  const background = new BackgroundWork({ platform, log: createLogger("test"), onChange: (view) => changes.push(view), now: () => now.value });
  return { background, calls, changes, platform, now };
}

describe("resolveGitHubToken", () => {
  it("uses the SDK's documented order: token variables first, then the GitHub CLI", async () => {
    const gh = async () => "gho_from_cli";
    expect(await resolveGitHubToken({ GITHUB_TOKEN: "ghp_last", MANAGED_COPILOT_GITHUB_TOKEN: " ghp_first \n" }, gh)).toBe("ghp_first");
    expect(await resolveGitHubToken({ COPILOT_GITHUB_TOKEN: "", GH_TOKEN: "ghp_gh" }, gh)).toBe("ghp_gh");
    expect(await resolveGitHubToken({}, gh)).toBe("gho_from_cli");
  });

  it("asks for a sign-in when there is no token anywhere", async () => {
    const missing = async () => {
      throw new Error("gh: command not found");
    };
    await expect(resolveGitHubToken({}, missing)).rejects.toMatchObject({ code: "authentication_required" });
  });
});

describe("BackgroundWork", () => {
  it("reports on, never-turned-on, and turned-off states in plain words", async () => {
    let status: unknown = { account: OCTO, active: true, createdAt: "2026-10-24T08:00:00.000Z" };
    const { background, calls, changes } = setup(async () => status);
    expect(background.view.state).toBe("unknown");
    expect(await background.refresh("test")).toMatchObject({ state: "on", login: "octo", since: "2026-10-24T08:00:00.000Z" });
    expect(calls).toEqual([`GET ${BACKGROUND_ROUTE}`]);

    status = { account: OCTO, active: false, reason: "Not signed in for background work. Sign in once with `npx managed-copilot login` so work can continue while you're away." };
    // Never turned on: the platform's CLI hint isn't shown; the app has its own copy.
    expect(await background.refresh("test")).toMatchObject({ state: "off", login: "octo", reason: undefined });

    status = { account: OCTO, active: false, createdAt: "2026-10-24T08:00:00.000Z", reason: "Signed out with `managed-copilot logout`." };
    // Turned off by the person: plainly off, no "stopped" reason.
    expect(await background.refresh("test")).toMatchObject({ state: "off", reason: undefined });

    status = { account: OCTO, active: false, createdAt: "2026-10-24T08:00:00.000Z", reason: "GitHub no longer accepts the stored sign-in (it was revoked or expired). Run `npx managed-copilot login` again." };
    expect(await background.refresh("test")).toMatchObject({ state: "off", reason: "GitHub no longer accepts the saved sign-in (it was revoked or expired)." });
    expect(changes.map((view) => view.state)).toEqual(["on", "off", "off"]);
  });

  it("only broadcasts when something other than the check time changed", async () => {
    const now = { value: 1_000_000 };
    const { background, changes } = setup(async () => ({ account: OCTO, active: true, createdAt: "2026-10-24T08:00:00.000Z" }), now);
    await background.refresh("test");
    now.value += 60_000;
    await background.refresh("test");
    expect(changes).toHaveLength(1);
  });

  it("tells an unreachable platform apart from one without background work", async () => {
    let failure: Error = new ManagedCopilotError("not_found", "No route");
    const { background } = setup(async () => {
      throw failure;
    });
    expect((await background.refresh("test")).state).toBe("unavailable");
    failure = new ManagedCopilotError("capability_unavailable", "Durable actions are not available in this build");
    expect((await background.refresh("test")).state).toBe("unavailable");
    failure = new ManagedCopilotError("capability_unavailable", "Cannot reach the Managed Copilot deployment", { reason: "unreachable" });
    expect(await background.refresh("test")).toMatchObject({ state: "error", error: "Cannot reach the Managed Copilot deployment" });
  });

  it("never shows another account's status as this person's", async () => {
    const { background } = setup(async () => ({ account: { id: 2, login: "someone-else" }, active: true, createdAt: "2026-10-24T08:00:00.000Z" }));
    expect(await background.refresh("test")).toMatchObject({ state: "error" });
  });

  it("turns on and off, and a status read that overlapped the change can't undo it", async () => {
    let active = false;
    let releaseRead: () => void = () => undefined;
    const { background, calls } = setup(async (method) => {
      if (method === "GET") {
        const snapshot = active;
        await new Promise<void>((resolve) => (releaseRead = resolve));
        return { account: OCTO, active: snapshot, ...(snapshot ? { createdAt: "x" } : {}) };
      }
      active = method === "POST";
      return { account: OCTO, active, createdAt: "2026-10-24T09:00:00.000Z", ...(active ? {} : { reason: "Signed out with `managed-copilot logout`." }) };
    });
    const staleRead = background.refresh("test");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await background.enable()).toMatchObject({ state: "on", login: "octo" });
    releaseRead();
    await staleRead;
    expect(background.view.state).toBe("on");
    expect(await background.disable()).toMatchObject({ state: "off", reason: undefined });
    expect(calls).toEqual([`GET ${BACKGROUND_ROUTE}`, `POST ${BACKGROUND_ROUTE}`, `DELETE ${BACKGROUND_ROUTE}`]);
  });

  it("explains a failed change without changing the status", async () => {
    const { background } = setup(async (method) => {
      if (method === "GET") return { account: OCTO, active: false };
      throw new ManagedCopilotError("authentication_required", "GitHub rejected the token");
    });
    await background.refresh("test");
    await expect(background.enable()).rejects.toMatchObject({ code: "background_failed", message: /Couldn't turn on background work: GitHub rejected the token/ });
    expect(background.view.state).toBe("off");
  });

  it("re-checks before refusing an action that needs it, so a terminal login counts right away", async () => {
    let active = false;
    const { background, calls } = setup(async () => ({ account: OCTO, active, ...(active ? { createdAt: "x" } : {}) }));
    await background.ensureOn(); // unknown: let the platform decide
    expect(calls).toHaveLength(0);
    await background.refresh("test");
    await expect(background.ensureOn()).rejects.toMatchObject({ code: "background_work_off" });
    active = true; // `npx managed-copilot login` in a terminal
    await expect(background.ensureOn()).resolves.toBeUndefined();
    expect(background.view.state).toBe("on");
  });

  it("checks more often while it's off, and starts over when the platform connection is replaced", async () => {
    const now = { value: 1_000_000 };
    let active = false;
    const { background } = setup(async () => ({ account: OCTO, active }), now);
    expect(background.due()).toBe(true);
    await background.refresh("test");
    expect(background.due()).toBe(false);
    now.value += 30_000;
    expect(background.due()).toBe(true);
    active = true;
    await background.refresh("test");
    now.value += 60_000;
    expect(background.due()).toBe(false);
    expect(background.due(10_000)).toBe(true);
    now.value += 5 * 60_000;
    expect(background.due()).toBe(true);
    background.reset();
    expect(background.view.state).toBe("unknown");
    expect(background.due()).toBe(true);
  });

  it("needs a platform connection to change anything", async () => {
    const { background, platform } = setup(async () => ({ account: OCTO, active: true }));
    platform.managed = undefined;
    await expect(background.enable()).rejects.toMatchObject({ code: "platform_unavailable" });
    expect((await background.refresh("test")).state).toBe("unknown");
  });
});

describe("background reasons", () => {
  it("recognizes the platform's background sign-in errors", () => {
    expect(isBackgroundWorkError("Could not schedule the task: The user has not enabled background work for this deployment")).toBe(true);
    expect(isBackgroundWorkError("octo has no active background sign-in for this deployment.")).toBe(true);
    expect(isBackgroundWorkError("Provide exactly one of delaySeconds, runAt, or cron")).toBe(false);
    expect(isBackgroundWorkError(undefined)).toBe(false);
  });

  it("puts the platform's reasons in plain words for this app", () => {
    expect(backgroundReason("GitHub no longer accepts the stored sign-in (it was revoked or expired). Run `npx managed-copilot login` again.")).toBe(
      "GitHub no longer accepts the saved sign-in (it was revoked or expired).",
    );
    expect(backgroundReason("The stored sign-in now belongs to a different GitHub account. Run `npx managed-copilot login` again.")).toBe(
      "The saved GitHub sign-in now belongs to a different account.",
    );
    expect(backgroundReason("Something unrelated")).toBeUndefined();
    expect(pausedReasonText("Paused: octo has no active background sign-in for this deployment. Signed out with `managed-copilot logout`.")).toBe(
      "Background work was turned off",
    );
    expect(pausedReasonText("Paused: octo has no active background sign-in for this deployment. Sign in once with `npx managed-copilot login` so work can continue while you're away.")).toBe(
      "Background work is off",
    );
    expect(pausedReasonText("Paused: The session this schedule continues no longer exists")).toBe("The session this schedule continues no longer exists");
    expect(pausedReasonText(undefined)).toBeUndefined();
  });
});

describe("blocked scheduling in the chat", () => {
  let seq = 0;
  const event = (type: string, data: Record<string, unknown>): SessionEvent =>
    ({ id: `bg-${++seq}`, parentId: null, timestamp: new Date(Date.UTC(2026, 9, 24, 8, 0, seq)).toISOString(), type, data }) as unknown as SessionEvent;

  it("offers to turn on background work when schedule_task fails for that reason", () => {
    const t = new Timeline({ timeZone: () => "UTC", scheduleNameFor: () => undefined, isOffline: () => false, isActionable: () => false });
    t.apply(event("tool.execution_start", { toolCallId: "s1", toolName: "schedule_task", arguments: { prompt: "Stretch", delaySeconds: 60 } }));
    t.apply(
      event("tool.execution_complete", {
        toolCallId: "s1",
        success: false,
        error: { message: "Could not schedule the task: The user has not enabled background work for this deployment, so nothing can run while they are away. Ask them to run `npx managed-copilot login` once, then try again." },
      }),
    );
    expect(t.get("s1")).toMatchObject({ status: "failed", needsBackgroundWork: true, error: expect.stringMatching(/^Background work is off/) });

    t.apply(event("tool.execution_start", { toolCallId: "s2", toolName: "schedule_task", arguments: { prompt: "x" } }));
    t.apply(event("tool.execution_complete", { toolCallId: "s2", success: false, error: { message: "Provide exactly one of delaySeconds, runAt, or cron" } }));
    expect(t.get("s2")).toMatchObject({ needsBackgroundWork: undefined, error: "Provide exactly one of delaySeconds, runAt, or cron" });
  });
});
