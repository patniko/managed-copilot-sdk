import { CloudIcon, CopilotIcon, LightBulbIcon, LockIcon } from "@primer/octicons-react";
import { useEffect, useRef, useState } from "react";
import type { UserView } from "../../shared/types.js";
import { greeting } from "../lib/format.js";
import { refreshOptions, startConversation, useStore } from "../lib/store.js";
import { Composer, type ComposerHandle } from "./Composer.js";
import { BillingChip } from "./Header.js";
import { Callout, Spinner } from "./ui/index.js";

const SUGGESTIONS = [
  { label: "Remember a preference", prompt: "Remember that I prefer short answers with bullet points." },
  { label: "What do you remember?", prompt: "What do you remember about me?" },
  { label: "Plan my week", prompt: "Help me plan a focused work week with time for deep work and exercise." },
  { label: "Explain something", prompt: "Explain how passkeys work, like I'm new to them." },
];

/** The start page: a greeting, what's private, who pays, and the first message of a new conversation. */
export function Home({ user }: { readonly user: UserView }) {
  const [text, setText] = useState("");
  const sending = useStore((state) => (state.outgoing.new ?? []).length > 0);
  const appUsers = useStore((state) => state.me?.options.appUsers);
  const composer = useRef<ComposerHandle>(null);
  const blocked = user.kind !== "github" && appUsers && !appUsers.available ? appUsers.reason : undefined;
  const outOfMessages = user.billing.remainingToday === 0;

  // Front Desk may still be connecting to Managed Copilot: check again until people without GitHub can chat.
  useEffect(() => {
    if (!blocked) return;
    const timer = setInterval(() => void refreshOptions(), 10_000);
    return () => clearInterval(timer);
  }, [blocked]);

  const submit = async (prompt = text) => {
    setText(prompt);
    const started = await startConversation(prompt);
    if (started) setText("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-6 px-4 py-10 sm:px-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="grid size-12 place-items-center rounded-full border border-line bg-canvas shadow-sm" aria-hidden>
            <CopilotIcon size={24} />
          </span>
          <h1 className="text-2xl font-semibold">{greeting(user.name)}</h1>
          <p className="max-w-xl text-fg-muted">
            Ask Front Desk anything. It can remember things about you across conversations, and only you can see what you talk about.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-fg-muted">
            <span className="inline-flex items-center gap-1">
              <LockIcon size={12} />
              Private to you
            </span>
            <span aria-hidden>·</span>
            <BillingChip billing={user.billing} />
            {user.billing.remainingToday !== undefined ? (
              <span>
                {user.billing.remainingToday} of {user.billing.dailyLimit} messages left today
              </span>
            ) : null}
          </div>
        </div>

        {blocked ? (
          <Callout tone="warning" title="Chatting isn't available for email accounts here yet">
            {blocked}
          </Callout>
        ) : outOfMessages ? (
          <Callout tone="warning" title="You've used today's messages">
            Front Desk pays for your conversations, so each person gets {user.billing.dailyLimit} messages a day. Your allowance starts again at midnight UTC.
          </Callout>
        ) : null}

        <Composer
          ref={composer}
          value={text}
          onChange={setText}
          onSubmit={() => void submit()}
          label="Start a new conversation"
          placeholder="Message Front Desk…"
          sending={sending}
          disabled={Boolean(blocked) || outOfMessages || sending}
          autoFocus
          minRows={3}
          footer={
            sending ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner size={12} />
                Starting your conversation…
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                {user.billing.route === "copilot" ? <CopilotIcon size={12} /> : <CloudIcon size={12} />}
                {user.billing.route === "copilot" ? "Uses your Copilot plan" : "Front Desk pays for this conversation"}
              </span>
            )
          }
        />

        <div className="flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              className="btn btn-sm rounded-full"
              disabled={Boolean(blocked) || outOfMessages || sending}
              onClick={() => void submit(suggestion.prompt)}
              title={suggestion.prompt}
            >
              {suggestion.label === "Remember a preference" ? <LightBulbIcon size={14} /> : null}
              {suggestion.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
