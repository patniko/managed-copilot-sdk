import { CloudIcon, CopilotIcon, DeviceDesktopIcon, LockIcon, MarkGithubIcon } from "@primer/octicons-react";
import { useState, type FormEvent } from "react";
import { LIMITS, type AuthOptions } from "../../shared/types.js";
import { ApiError } from "../lib/api.js";
import { cx } from "../lib/cx.js";
import { signIn, signInWithLocalGitHub, signUp, useStore } from "../lib/store.js";
import { Callout, Spinner } from "./ui/index.js";

/** Why a GitHub sign-in came back without signing in, from `?signin_error=<code>`. */
const SIGN_IN_ERRORS: Readonly<Record<string, string>> = {
  denied: "You cancelled the GitHub sign-in.",
  expired: "That GitHub sign-in expired or was started in another browser. Try again.",
  not_configured: "GitHub sign-in isn't set up on this Front Desk. Use an email and password instead.",
  callback_mismatch: `GitHub refused to send you back here. Whoever runs Front Desk needs to add ${window.location.origin}/auth/github/callback as a callback URL of its GitHub app.`,
  needs_sign_in: "GitHub didn't accept that sign-in. Try again.",
  failed: "GitHub sign-in didn't work. Try again in a moment.",
};

function readSignInError(): string | undefined {
  const code = new URLSearchParams(window.location.search).get("signin_error");
  if (!code) return undefined;
  window.history.replaceState(null, "", window.location.pathname);
  return SIGN_IN_ERRORS[code] ?? SIGN_IN_ERRORS.failed;
}

export function SignIn({ options }: { readonly options: AuthOptions }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | undefined>(readSignInError);
  const reason = useStore((state) => state.signedOutReason);
  const [busy, setBusy] = useState<"form" | "local" | undefined>();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("form");
    setError(undefined);
    try {
      if (mode === "signup") await signUp({ name, email, password, ...(options.inviteRequired ? { invite } : {}) });
      else await signIn({ email, password });
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure));
      setBusy(undefined);
    }
  };

  const local = async () => {
    setBusy("local");
    setError(undefined);
    try {
      await signInWithLocalGitHub();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : String(failure));
      setBusy(undefined);
    }
  };

  const hasGitHub = options.github || options.localGitHub;
  return (
    <div className="signin-backdrop flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-[26rem] flex-col items-center gap-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="grid size-14 place-items-center rounded-full border border-line bg-canvas shadow-sm" aria-hidden>
            <CopilotIcon size={28} />
          </span>
          <h1 className="text-xl font-semibold">Sign in to Front Desk</h1>
          <p className="text-sm text-fg-muted">An assistant for everyone. Your conversations and memory are yours alone.</p>
        </div>

        {reason ? <Callout tone="warning" role="alert" className="w-full">{reason}</Callout> : null}
        {error ? (
          <Callout tone="danger" role="alert" className="w-full">
            {error}
          </Callout>
        ) : null}

        <div className="Box w-full bg-canvas shadow-sm">
          {hasGitHub ? (
            <div className="flex flex-col gap-2 p-4">
              {options.github ? (
                <a href={`/auth/github?return=${encodeURIComponent(window.location.pathname)}`} className="btn btn-block btn-lg justify-center bg-canvas-emphasis text-fg-on-emphasis hover:bg-canvas-emphasis hover:text-fg-on-emphasis hover:opacity-90">
                  <MarkGithubIcon size={20} />
                  Continue with GitHub
                </a>
              ) : null}
              {options.localGitHub ? (
                <button type="button" className={cx("btn btn-block justify-center", !options.github && "btn-lg")} disabled={busy !== undefined} onClick={() => void local()}>
                  {busy === "local" ? <Spinner size={16} /> : <DeviceDesktopIcon size={16} />}
                  Use this computer's GitHub sign-in
                </button>
              ) : null}
              <p className="flex items-start gap-1.5 text-xs text-fg-muted">
                <CopilotIcon size={12} className="mt-0.5 shrink-0" />
                <span>
                  With GitHub, your conversations use <strong className="font-semibold text-fg">your own Copilot plan</strong>.
                  {options.localGitHub ? " The second button only appears when Front Desk runs on your own computer." : ""}
                </span>
              </p>
            </div>
          ) : null}

          {hasGitHub ? (
            <div className="flex items-center gap-3 px-4 text-xs text-fg-muted" aria-hidden>
              <span className="h-px flex-1 bg-[var(--borderColor-muted)]" />
              or use your email
              <span className="h-px flex-1 bg-[var(--borderColor-muted)]" />
            </div>
          ) : null}

          <form className="flex flex-col gap-3 p-4" onSubmit={(event) => void submit(event)}>
            <div className="SegmentedControl SegmentedControl--sm w-full" role="group" aria-label="Sign in or create an account">
              <button type="button" className="SegmentedControl-item flex-1" aria-current={mode === "signin"} onClick={() => setMode("signin")}>
                Sign in
              </button>
              <button type="button" className="SegmentedControl-item flex-1" aria-current={mode === "signup"} onClick={() => setMode("signup")}>
                Create an account
              </button>
            </div>
            {mode === "signup" ? (
              <label className="FormControl">
                <span className="FormControl-label">Your name</span>
                <input className="form-control" autoComplete="name" required maxLength={LIMITS.name} value={name} onChange={(event) => setName(event.target.value)} />
              </label>
            ) : null}
            <label className="FormControl">
              <span className="FormControl-label">Email</span>
              <input className="form-control" type="email" autoComplete="email" required maxLength={LIMITS.email} value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label className="FormControl">
              <span className="FormControl-label">Password</span>
              <input
                className="form-control"
                type="password"
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                required
                minLength={mode === "signup" ? LIMITS.passwordMin : undefined}
                maxLength={LIMITS.passwordMax}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {mode === "signup" ? <span className="FormControl-caption">At least {LIMITS.passwordMin} characters.</span> : null}
            </label>
            {mode === "signup" && options.inviteRequired ? (
              <label className="FormControl">
                <span className="FormControl-label">Invitation code</span>
                <input className="form-control" autoComplete="off" required value={invite} onChange={(event) => setInvite(event.target.value)} />
                <span className="FormControl-caption">Ask whoever runs this Front Desk for it.</span>
              </label>
            ) : null}
            <button type="submit" className="btn btn-primary btn-block justify-center" disabled={busy !== undefined}>
              {busy === "form" ? <Spinner size={16} /> : null}
              {mode === "signup" ? "Create account" : "Sign in"}
            </button>
            <p className="flex items-start gap-1.5 text-xs text-fg-muted">
              <CloudIcon size={12} className="mt-0.5 shrink-0" />
              <span>
                No GitHub account? No problem: <strong className="font-semibold text-fg">Front Desk pays</strong> for your conversations through its Azure AI Foundry.
                {!options.appUsers.available && options.appUsers.reason ? ` ${options.appUsers.reason}` : ""}
              </span>
            </p>
          </form>
        </div>

        <p className="flex items-center gap-1.5 text-xs text-fg-muted">
          <LockIcon size={12} />
          Built on Managed Copilot: each person's sessions run as them, and no one can open anyone else's.
        </p>
      </div>
    </div>
  );
}
