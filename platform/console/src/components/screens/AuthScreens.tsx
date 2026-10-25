import type { LucideIcon } from "lucide-react";
import { CloudOff, Gauge, KeyRound, LinkIcon, LogIn, LogOut, RotateCcw, ShieldX, Unplug } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { CONSOLE_TICKET_TTL_SECONDS } from "@managed-copilot/protocol/operator";
import { retryAuth, signOut, type SignedOutReason } from "../../lib/auth.js";
import { cx } from "../../lib/cx.js";
import type { ApiError } from "../../lib/errors.js";
import { consoleCommand } from "../../lib/signin.js";
import { useNow } from "../../lib/time.js";
import { TONE_TILE, type Tone } from "../../lib/tone.js";
import { Button } from "../ui/Button.js";
import { CopyButton } from "../ui/CopyButton.js";
import { InlineCode, Skeleton, Spinner } from "../ui/Feedback.js";

function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Managed Copilot console`;
  }, [title]);
}

function AuthLayout({ icon: Icon, tone, title, children }: { readonly icon: LucideIcon; readonly tone: Tone; readonly title: string; readonly children: ReactNode }) {
  useDocumentTitle(title);
  return (
    <div className="flex min-h-dvh flex-col bg-zinc-950 bg-grid">
      <header className="flex h-14 items-center gap-2.5 px-5">
        <span className="grid size-8 place-items-center rounded-lg bg-amber-400/15 text-amber-300 ring-1 ring-inset ring-amber-400/30">
          <Gauge className="size-[18px]" aria-hidden />
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-zinc-100">Managed Copilot</span>
        <span className="text-[13px] text-zinc-500">Operator console</span>
      </header>
      <main className="grid flex-1 place-items-center px-5 pb-16">
        <div className="w-full max-w-lg animate-rise-in rounded-2xl border border-zinc-800 bg-zinc-900/80 p-7 shadow-2xl shadow-black/40 backdrop-blur">
          <div className={cx("grid size-11 place-items-center rounded-2xl ring-1 ring-inset", TONE_TILE[tone])}>
            <Icon className="size-5" aria-hidden />
          </div>
          <h1 className="mt-5 text-xl font-semibold tracking-tight text-zinc-50">{title}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}

function Prose({ children }: { readonly children: ReactNode }) {
  return <p className="mt-2 text-[13.5px] leading-relaxed text-zinc-400">{children}</p>;
}

/** The terminal command that opens the console signed in, with a copy button. */
function SignInCommand() {
  const command = consoleCommand(window.location.origin);
  return (
    <div className="mt-4 flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950 py-2 pr-2 pl-3.5">
      <span className="font-mono text-[12px] text-zinc-500 select-none" aria-hidden>
        $
      </span>
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[13px] whitespace-nowrap text-zinc-100">{command}</code>
      <CopyButton text={command} label="Copy sign-in command" size="sm" variant="secondary">
        Copy
      </CopyButton>
    </div>
  );
}

function ServerMessage({ message, label = "From the gateway" }: { readonly message: string | undefined; readonly label?: string }) {
  if (!message) return null;
  return (
    <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3.5 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500">{label}</p>
      <p className="mt-1 text-[13px] leading-relaxed break-words text-zinc-300">
        <InlineCode text={message} />
      </p>
    </div>
  );
}

/** First paint while the console checks its session. */
export function BootScreen() {
  useDocumentTitle("Loading");
  return (
    <div className="flex h-dvh flex-col" role="status" aria-label="Loading the operator console">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-zinc-800/80 px-4">
        <span className="grid size-8 place-items-center rounded-lg bg-amber-400/15 text-amber-300 ring-1 ring-inset ring-amber-400/30">
          <Gauge className="size-[18px]" aria-hidden />
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-zinc-100">Operator console</span>
        <div className="ml-auto flex gap-2">
          <Skeleton className="h-8 w-20 rounded-full" />
          <Skeleton className="h-8 w-28 rounded-full" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-60 shrink-0 space-y-2 border-r border-zinc-800/80 px-3 py-5 lg:block">
          {Array.from({ length: 11 }, (_, index) => (
            <Skeleton key={index} className={cx("h-6", index === 4 ? "mt-6" : undefined)} />
          ))}
        </div>
        <div className="flex-1 px-8 py-7">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="mt-3 h-4 w-96 max-w-full" />
          <div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-28 rounded-2xl" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SigningInScreen() {
  return (
    <AuthLayout icon={LogIn} tone="active" title="Signing you in…">
      <div className="mt-3 flex items-center gap-2.5 text-[13.5px] text-zinc-400" role="status">
        <Spinner />
        Redeeming your one-time sign-in link.
      </div>
    </AuthLayout>
  );
}

export function SignedOutScreen({ reason, message }: { readonly reason: SignedOutReason; readonly message?: string }) {
  if (reason === "signed-out") {
    return (
      <AuthLayout icon={LogOut} tone="neutral" title="Signed out">
        <Prose>You signed out of the operator console. To sign in again, run this in a terminal signed in to GitHub:</Prose>
        <SignInCommand />
        <Prose>It opens the console with a one-time sign-in link.</Prose>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout icon={KeyRound} tone="warning" title="Sign in to the operator console">
      <Prose>
        {reason === "ended" ? "Your console session ended. " : null}
        The console signs in through your terminal with the GitHub account you use for Managed Copilot. Run:
      </Prose>
      <SignInCommand />
      <Prose>It opens this console with a one-time link that expires after {CONSOLE_TICKET_TTL_SECONDS} seconds.</Prose>
      <ServerMessage message={message} />
    </AuthLayout>
  );
}

export function TicketFailedScreen({ message }: { readonly message?: string }) {
  return (
    <AuthLayout icon={LinkIcon} tone="warning" title="This sign-in link has expired or was already used">
      <Prose>Sign-in links work once and expire after {CONSOLE_TICKET_TTL_SECONDS} seconds. Run the command again for a new one:</Prose>
      <SignInCommand />
      <ServerMessage message={message} />
    </AuthLayout>
  );
}

export function ForbiddenScreen({ message, login }: { readonly message: string; readonly login?: string }) {
  const [busy, setBusy] = useState(false);
  const snippet = `addManagedCopilot(builder, "copilot", {\n  operators: { githubUsers: ["${login ?? "your-github-login"}"] },\n  // ...\n});`;
  return (
    <AuthLayout icon={ShieldX} tone="danger" title="You're not an operator of this deployment">
      <ServerMessage message={message} />
      <Prose>
        <InlineCode text="Operators are named in the AppHost. To give an account access, add its GitHub login to `operators` in `addManagedCopilot`, then restart the AppHost:" />
      </Prose>
      <div className="relative mt-3 rounded-xl border border-zinc-800 bg-zinc-950">
        <pre className="overflow-x-auto px-3.5 py-3 pr-12 font-mono text-[12.5px] leading-relaxed text-zinc-200">{snippet}</pre>
        <div className="absolute top-2 right-2">
          <CopyButton text={snippet} label="Copy AppHost snippet" />
        </div>
      </div>
      <Prose>Or sign out and sign in with an operator account.</Prose>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="primary" icon={RotateCcw} onClick={() => retryAuth()}>
          Try again
        </Button>
        <Button
          variant="ghost"
          icon={LogOut}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await signOut();
            setBusy(false);
          }}
        >
          Sign out
        </Button>
      </div>
    </AuthLayout>
  );
}

export function GitHubUnavailableScreen({ message, retryAt, retrying = false }: { readonly message: string; readonly retryAt?: number; readonly retrying?: boolean }) {
  const now = useNow(1000);
  const [attemptedAt, setAttemptedAt] = useState<number | undefined>(undefined);
  const waitSeconds = retryAt !== undefined ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;

  useEffect(() => {
    if (retryAt === undefined || attemptedAt === retryAt) return;
    const timer = setTimeout(() => {
      setAttemptedAt(retryAt);
      retryAuth();
    }, Math.max(0, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [retryAt, attemptedAt]);

  return (
    <AuthLayout icon={CloudOff} tone="warning" title="GitHub is unreachable right now">
      <Prose>The gateway checks operator access with GitHub and couldn&apos;t reach it. This is usually brief.</Prose>
      <ServerMessage message={message} />
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={RotateCcw} loading={retrying} disabled={waitSeconds > 0} onClick={() => retryAuth()}>
          {retrying ? "Checking…" : waitSeconds > 0 ? `Try again in ${waitSeconds}s` : "Try again"}
        </Button>
        {waitSeconds > 0 && !retrying ? <span className="text-[12.5px] text-zinc-500">The console retries automatically.</span> : null}
      </div>
    </AuthLayout>
  );
}

export function UnreachableScreen({ error, retrying = false }: { readonly error: ApiError; readonly retrying?: boolean }) {
  const network = error.code === "network_error" || error.code === "timeout";
  return (
    <AuthLayout icon={Unplug} tone="danger" title={network ? "Can't reach the gateway" : "The console couldn't load"}>
      <Prose>
        {network
          ? `The console needs its gateway at ${window.location.origin}. Check that it's running, then try again.`
          : "The gateway answered with an error. Try again; if it keeps happening, check the gateway's logs."}
      </Prose>
      <ServerMessage message={error.message} label={network ? "Details" : "From the gateway"} />
      <div className="mt-6">
        <Button variant="primary" icon={RotateCcw} loading={retrying} onClick={() => retryAuth()}>
          {retrying ? "Trying again…" : "Try again"}
        </Button>
      </div>
    </AuthLayout>
  );
}
