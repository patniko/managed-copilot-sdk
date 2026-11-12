import { BookIcon, CheckIcon, LightBulbIcon, TrashIcon, XIcon } from "@primer/octicons-react";
import { useState } from "react";
import type { KnowledgeEntry, MemoryProposal } from "../../shared/types.js";
import { customerHref } from "../lib/router.js";
import { decide, forget, useStore } from "../lib/store.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

const COLLAPSED = 5;
const DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The team knowledge base: facts agents proposed and a team member added. Every new conversation starts with them. */
export function Knowledge() {
  const knowledge = useStore((state) => state.knowledge);
  const proposals = useStore((state) => state.proposals);
  const phase = useStore((state) => state.phase);
  const [expanded, setExpanded] = useState(false);
  if (phase !== "ready") return null;
  const shown = expanded ? knowledge : knowledge.slice(0, COLLAPSED);
  return (
    <section aria-label="Team knowledge" className="Box mt-4">
      <div className="Box-header py-2">
        <BookIcon size={16} className="shrink-0 text-fg-muted" />
        <h2 className="Box-title">Team knowledge</h2>
        <span className="Counter">{knowledge.length}</span>
        <span className="ml-auto min-w-0 truncate text-xs text-fg-muted max-md:hidden">Learned in earlier conversations; every new conversation starts with it</span>
      </div>
      {proposals.length > 0 ? (
        <ul aria-label="Proposed facts" className="border-b border-line-muted bg-attention-muted">
          {proposals.map((proposal) => (
            <ProposalRow key={proposal.id} proposal={proposal} />
          ))}
        </ul>
      ) : null}
      {knowledge.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-3 text-sm text-fg-muted">
          <LightBulbIcon size={16} className="shrink-0" />
          Nothing yet. When an agent learns something worth sharing, it proposes it here for you to add.
        </p>
      ) : (
        <ul>
          {shown.map((entry) => (
            <KnowledgeRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
      {knowledge.length > COLLAPSED ? (
        <div className="border-t border-line-muted px-4 py-1.5">
          <button type="button" className="btn-link text-xs" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Show less" : `Show all ${knowledge.length}`}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** The source line of a fact: the conversation it came from, linked while that conversation is on the wall. */
function Source({ source, at, verb, title }: { readonly source: KnowledgeEntry["source"]; readonly at: string; readonly verb: string; readonly title?: string }) {
  const live = useStore((state) => state.tickets[source.customerId]?.sessionId === source.sessionId);
  const text = `${verb} ${source.name}'s conversation · ${DATE.format(new Date(at))}`;
  return (
    <div className="truncate text-xs text-fg-muted" title={title}>
      {live ? (
        <a href={customerHref(source.customerId)} className="Link--secondary">
          {text}
        </a>
      ) : (
        text
      )}
    </div>
  );
}

/** A fact an agent proposed: the operator adds it or not. The agent's conversation never hears which. */
function ProposalRow({ proposal }: { readonly proposal: MemoryProposal }) {
  const busy = useStore((state) => Boolean(state.answering[proposal.id]));
  return (
    <li className="Box-row flex min-w-0 flex-wrap items-start gap-3 py-2.5">
      <LightBulbIcon size={16} className="mt-0.5 shrink-0 text-fg-attention" />
      <div className="min-w-0 flex-1 basis-60">
        <div className="text-sm">
          <span className="text-fg-muted">Proposed: </span>
          <span className="font-semibold">{proposal.subject}</span>
          <span className="text-fg-muted"> · </span>
          {proposal.fact}
        </div>
        <Source source={proposal.source} at={proposal.at} verb="From" title={proposal.reason ? `Why: ${proposal.reason}` : undefined} />
      </div>
      <div className="flex shrink-0 gap-2">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void decide(proposal.id, false)}>
          <XIcon size={16} />
          Don't add
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void decide(proposal.id, true)}>
          <CheckIcon size={16} className="text-fg-success!" />
          Add
        </button>
      </div>
    </li>
  );
}

function KnowledgeRow({ entry }: { readonly entry: KnowledgeEntry }) {
  const busy = useStore((state) => Boolean(state.forgetting[entry.id]));
  return (
    <li className="Box-row flex min-w-0 items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm">
          <span className="font-semibold">{entry.subject}</span>
          <span className="text-fg-muted"> · </span>
          {entry.fact}
        </div>
        <Source source={entry.source} at={entry.at} verb="From" title={entry.reason ? `Why: ${entry.reason}` : undefined} />
      </div>
      <Tooltip content="Remove from team knowledge" className="shrink-0">
        <button type="button" className="btn btn-sm btn-icon btn-invisible" aria-label={`Remove "${entry.subject}" from team knowledge`} disabled={busy} onClick={() => void forget(entry.id)}>
          {busy ? <Spinner size={16} /> : <TrashIcon size={16} />}
        </button>
      </Tooltip>
    </li>
  );
}
