import { CloudOfflineIcon, CopyIcon, KeyIcon, LinkIcon, MarkGithubIcon, PlugIcon, StopIcon, SyncIcon, type Icon } from "@primer/octicons-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { CONSOLE_TICKET_TTL_SECONDS } from "@managed-copilot/protocol/operator";
import { retryAuth, signOut, type SignedOutReason } from "../../lib/auth.js";
import { copyText } from "../../lib/clipboard.js";
import { cx } from "../../lib/cx.js";
import type { ApiError } from "../../lib/errors.js";
import { consoleCommand } from "../../lib/signin.js";
import { useNow } from "../../lib/time.js";
import { toast } from "../../lib/toast.js";
import type { Tone } from "../../lib/tone.js";
import { useDocumentTitle } from "../layout/Page.js";
import { Button } from "../ui/Button.js";
import { CodeBlock } from "../ui/CodeBlock.js";
import { Callout, InlineCode, Skeleton, SkeletonLines } from "../ui/Feedback.js";
import { Spinner } from "../ui/Spinner.js";

/** github.com's sign-in page: a centered narrow column with the GitHub mark, a light 24px heading, and a Box. */
function AuthLayout({ title, flash, children, footer }: { readonly title: string; readonly flash?: ReactNode; readonly children: ReactNode; readonly footer?: ReactNode }) {
  useDocumentTitle(title);
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <main className="flex flex-1 flex-col items-center px-4 pt-10 pb-12 sm:pt-16">
        <MarkGithubIcon size={48} />
        <h1 className="mt-6 mb-4 max-w-md text-center text-xl font-light text-balance">{title}</h1>
        <div className="w-full max-w-md animate-fade-in">
          {flash}
          <div className="rounded-md border border-line-muted bg-canvas-muted p-4">{children}</div>
          {footer ? <div className="mt-4 rounded-md border border-line p-4 text-center">{footer}</div> : null}
        </div>
      </main>
      <footer className="px-4 pb-8 text-center text-xs text-fg-muted">Managed Copilot · Operator console</footer>
    </div>
  );
}

function Prose({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <p className={cx("text-fg", className)}>{children}</p>;
}

/** The terminal command that opens the console signed in, like a clone URL on github.com: a read-only field and a copy button. */
function SignInCommand() {
  const command = consoleCommand(window.location.origin);
  const id = useId();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="mt-3 space-y-3">
      <div className="FormControl">
        <label htmlFor={id} className="FormControl-label">
          Run in a terminal signed in to GitHub
        </label>
        <input id={id} readOnly value={command} onFocus={(event) => event.currentTarget.select()} className="form-control input-block input-monospace" spellCheck={false} />
      </div>
      <Button
        variant="primary"
        icon={CopyIcon}
        className="btn-block"
        onClick={async () => {
          if (await copyText(command)) setCopied(true);
          else toast.error("Couldn't copy to the clipboard", "Select the command and copy it manually.");
        }}
      >
        {copied ? "Copied!" : "Copy command"}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </div>
  );
}

/** A message the gateway sent, as a flash banner. */
function ServerMessage({ message, label = "From the gateway", tone = "attention", icon }: { readonly message: string | undefined; readonly label?: string; readonly tone?: Tone; readonly icon?: Icon }) {
  if (!message) return null;
  return (
    <Callout tone={tone} icon={icon} title={label} className="mb-4">
      <InlineCode text={message} />
    </Callout>
  );
}

/** First paint while the console checks its session: the shell's outline. */
export function BootScreen() {
  useDocumentTitle("Loading");
  return (
    <div className="flex h-dvh flex-col bg-canvas" role="status" aria-label="Loading the operator console">
      <div className="AppHeader shrink-0">
        <div className="AppHeader-globalBar">
          <span className="AppHeader-logo text-fg">
            <MarkGithubIcon size={32} />
          </span>
          <span className="AppHeader-context">
            <span className="AppHeader-context-item hidden sm:inline-flex">Managed Copilot</span>
            <span className="AppHeader-context-divider hidden sm:inline">/</span>
            <span className="AppHeader-context-item AppHeader-context-item--current">Console</span>
          </span>
          <div className="AppHeader-actions">
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="size-8 rounded-full" />
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-64 shrink-0 space-y-3 border-r border-line px-6 py-5 lg:block">
          {Array.from({ length: 11 }, (_, index) => (
            <Skeleton key={index} className={cx("h-5", index === 4 ? "mt-8" : undefined, index % 3 === 0 ? "w-3/4" : "w-full")} />
          ))}
        </div>
        <div className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-8 md:px-6 lg:px-8">
          <Skeleton className="h-8 w-48" />
          <SkeletonLines lines={1} className="mt-3 w-96 max-w-full" />
          <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-28 rounded-md" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SigningInScreen() {
  return (
    <AuthLayout title="Signing you in…">
      <div className="flex items-center justify-center gap-2 py-2 text-fg-muted" role="status">
        <Spinner />
        Redeeming your one-time sign-in link.
      </div>
    </AuthLayout>
  );
}

export function SignedOutScreen({ reason, message }: { readonly reason: SignedOutReason; readonly message?: string }) {
  if (reason === "signed-out") {
    return (
      <AuthLayout title="Signed out" footer={<p className="text-fg-muted">It opens the console with a one-time sign-in link.</p>}>
        <Prose>You signed out of the operator console. To sign in again, run the console command.</Prose>
        <SignInCommand />
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title="Sign in to the operator console"
      flash={<ServerMessage message={message} icon={KeyIcon} />}
      footer={<p className="text-fg-muted">It opens this console with a one-time link that expires after {CONSOLE_TICKET_TTL_SECONDS} seconds.</p>}
    >
      <Prose>
        {reason === "ended" ? "Your console session ended. " : null}
        The console signs in through your terminal with the GitHub account you use for Managed Copilot.
      </Prose>
      <SignInCommand />
    </AuthLayout>
  );
}

export function TicketFailedScreen({ message }: { readonly message?: string }) {
  return (
    <AuthLayout title="This sign-in link has expired or was already used" flash={<ServerMessage message={message} icon={LinkIcon} />}>
      <Prose>Sign-in links work once and expire after {CONSOLE_TICKET_TTL_SECONDS} seconds. Run the command again for a new one.</Prose>
      <SignInCommand />
    </AuthLayout>
  );
}

export function ForbiddenScreen({ message, login }: { readonly message: string; readonly login?: string }) {
  const [busy, setBusy] = useState(false);
  const snippet = `addManagedCopilot(builder, "copilot", {\n  operators: { githubUsers: ["${login ?? "your-github-login"}"] },\n  // ...\n});`;
  return (
    <AuthLayout
      title="You're not an operator of this deployment"
      flash={<ServerMessage message={message} tone="danger" icon={StopIcon} />}
      footer={
        <p className="text-fg-muted">
          Or{" "}
          <button
            type="button"
            className="Link inline-flex items-center gap-1 align-bottom font-semibold"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await signOut();
              setBusy(false);
            }}
          >
            {busy ? <Spinner size={12} /> : null}
            sign out
          </button>{" "}
          and sign in with an operator account.
        </p>
      }
    >
      <Prose>
        <InlineCode text="Operators are named in the AppHost. To give an account access, add its GitHub login to `operators` in `addManagedCopilot`, then restart the AppHost:" />
      </Prose>
      <CodeBlock className="mt-3" text={snippet} label="AppHost" copyLabel="Copy AppHost snippet" maxHeight="none" wrap={false} />
      <Button variant="primary" icon={SyncIcon} className="btn-block mt-4" onClick={() => retryAuth()}>
        Try again
      </Button>
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
    <AuthLayout
      title="GitHub is unreachable right now"
      flash={<ServerMessage message={message} icon={CloudOfflineIcon} />}
      footer={waitSeconds > 0 && !retrying ? <p className="text-fg-muted">The console retries automatically.</p> : undefined}
    >
      <Prose>The gateway checks operator access with GitHub and couldn&apos;t reach it. This is usually brief.</Prose>
      <Button variant="primary" icon={SyncIcon} className="btn-block mt-4" loading={retrying} disabled={waitSeconds > 0} onClick={() => retryAuth()}>
        {retrying ? "Checking…" : waitSeconds > 0 ? `Try again in ${waitSeconds}s` : "Try again"}
      </Button>
    </AuthLayout>
  );
}

export function UnreachableScreen({ error, retrying = false }: { readonly error: ApiError; readonly retrying?: boolean }) {
  const network = error.code === "network_error" || error.code === "timeout";
  return (
    <AuthLayout
      title={network ? "Can't reach the gateway" : "The console couldn't load"}
      flash={<ServerMessage message={error.message} label={network ? "Details" : "From the gateway"} tone="danger" icon={PlugIcon} />}
    >
      <Prose>
        {network
          ? `The console needs its gateway at ${window.location.origin}. Check that it's running, then try again.`
          : "The gateway answered with an error. Try again; if it keeps happening, check the gateway's logs."}
      </Prose>
      <Button variant="primary" icon={SyncIcon} className="btn-block mt-4" loading={retrying} onClick={() => retryAuth()}>
        {retrying ? "Trying again…" : "Try again"}
      </Button>
    </AuthLayout>
  );
}
