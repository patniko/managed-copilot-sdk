import { ChevronRightIcon, ContainerIcon, CopilotIcon, CpuIcon, GlobeIcon, LinkExternalIcon, ShieldXIcon, XIcon } from "@primer/octicons-react";
import { Fragment, useEffect, useRef } from "react";
import type { Researcher, Run } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { duration, plural } from "../lib/format.js";
import { useStore } from "../lib/store.js";
import { ReportMarkdown } from "./Markdown.js";
import { ResearcherStateBadge } from "./Status.js";
import { Tooltip } from "./ui/Tooltip.js";

/** Where the run's work happened: the lead on the shared runtime, a sandbox per researcher, and the sites they could read. */
export function WhereItRan({ run, column = false, className }: { readonly run: Run; readonly column?: boolean; readonly className?: string }) {
  const swarm = useStore((state) => state.app?.swarm);
  const started = run.researchers.filter((researcher) => researcher.workerId);
  const sandboxes = run.researchers.flatMap((researcher, index) => (researcher.workerId ? [`Researcher ${index + 1}: ${researcher.sandboxId ?? "starting"}`] : []));
  const blocked = [...new Set(run.researchers.flatMap((researcher) => researcher.blocked.map((entry) => entry.host)))];
  const hosts = swarm?.researchers.hosts ?? [];
  const items = [
    { key: "lead", icon: <CpuIcon size={16} />, label: column ? "Lead on the shared runtime" : "Shared runtime", tip: `Lead: ${swarm?.lead.environment ?? "orchestrator"} · ${run.model}` },
    {
      key: "sandboxes",
      icon: <ContainerIcon size={16} />,
      label: `${plural(started.length, "sandbox", "sandboxes")}${run.cleanedUp && started.length > 0 ? " · deleted" : ""}`,
      tip: sandboxes.length ? sandboxes.join(" · ") : "Each researcher gets a sandbox when it starts.",
    },
    { key: "sites", icon: <GlobeIcon size={16} />, label: column ? `${plural(hosts.length, "allowed site")}` : plural(hosts.length, "site"), tip: hosts.length ? hosts.join(", ") : "The researchers' allowed sites" },
    ...(blocked.length > 0 ? [{ key: "blocked", icon: <ShieldXIcon size={16} />, label: `${blocked.length} blocked`, tip: `Blocked by the sandboxes' network rules: ${blocked.join(", ")}`, danger: true }] : []),
  ];
  return (
    <div className={cx(column ? "flex flex-col items-start gap-1.5" : "flex flex-wrap items-center gap-x-3 gap-y-2", "text-sm text-fg-muted", className)} aria-label="Where it ran">
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {!column && index > 0 && item.key !== "blocked" ? <ChevronRightIcon size={12} className="max-sm:hidden" aria-hidden /> : null}
          <Tooltip content={item.tip}>
            <span className={cx("inline-flex items-center gap-1.5", "danger" in item && "text-fg-danger")} tabIndex={0}>
              {item.icon}
              {item.label}
            </span>
          </Tooltip>
        </Fragment>
      ))}
    </div>
  );
}

/** The finished run's swarm, as a list beside the report: the lead, then each researcher with its sub-question. */
export function SwarmSummary({ run, onOpen }: { readonly run: Run; readonly onOpen: (id: string) => void }) {
  return (
    <section className="rounded-lg border border-line bg-canvas p-4" aria-label="The swarm">
      <div className="flex items-center gap-2 text-sm">
        <span className="grid size-7 place-items-center rounded-full bg-accent-muted text-fg-accent">
          <CopilotIcon size={16} />
        </span>
        <span className="font-semibold">Lead</span>
        <span className="ml-auto text-xs text-fg-muted" title="Time from question to report">
          {run.finishedAt ? duration(Date.parse(run.finishedAt) - Date.parse(run.createdAt)) : null}
        </span>
      </div>
      <ol className="mt-2 ml-3.5 flex flex-col gap-1 border-l-2 border-line-muted py-1 pl-3">
        {run.researchers.map((researcher, index) => (
          <li key={researcher.id}>
            <button type="button" onClick={() => onOpen(researcher.id)} className="w-full rounded-md p-2 text-left hover:bg-canvas-muted focus-visible:outline-2 focus-visible:outline-focus">
              <span className="flex items-center gap-2 text-sm">
                <ContainerIcon size={14} className="shrink-0 text-fg-muted" />
                <span className="font-medium">Researcher {index + 1}</span>
                <ResearcherStateBadge state={researcher.state} label={false} />
                <span className="ml-auto shrink-0 text-xs text-fg-muted">{plural(researcher.pages.length, "page")}</span>
              </span>
              <span className="mt-0.5 line-clamp-2 text-xs text-fg-muted" title={researcher.question}>
                {researcher.question}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <WhereItRan run={run} column className="mt-3 border-t border-line-muted pt-3" />
    </section>
  );
}

/** One researcher in detail: its sub-question, the pages it read, what was blocked, its findings, and its sandbox. */
export function ResearcherDialog({ run, researcher, onClose }: { readonly run: Run; readonly researcher: Researcher; readonly onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const index = run.researchers.indexOf(researcher);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="Dialog Dialog--medium backdrop:bg-backdrop"
      aria-labelledby="researcher-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current.close();
      }}
    >
      <div className="Dialog-header flex items-center gap-2">
        <ContainerIcon size={16} className="text-fg-muted" />
        <h2 id="researcher-title" className="Dialog-title">
          Researcher {index + 1}
        </h2>
        <ResearcherStateBadge state={researcher.state} />
        <button type="button" className="btn-octicon ml-auto" aria-label="Close" onClick={() => dialog.current?.close()}>
          <XIcon size={16} />
        </button>
      </div>
      <div className="Dialog-body flex flex-col gap-5 overflow-y-auto text-sm">
        <p className="text-base font-medium">{researcher.question}</p>
        <section>
          <h3 className="mb-1 text-xs font-semibold text-fg-muted">{researcher.pages.length ? `Read ${plural(researcher.pages.length, "page")}` : "No pages read"}</h3>
          <ul className="flex flex-col gap-1">
            {researcher.pages.map((page) => (
              <li key={page.url} className="min-w-0">
                <a href={page.url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1" title={page.url}>
                  <span className="truncate">{page.title}</span>
                  <LinkExternalIcon size={12} className="shrink-0 text-fg-muted" />
                </a>
                <span className="ml-2 text-xs text-fg-muted">{page.host}</span>
              </li>
            ))}
          </ul>
        </section>
        {researcher.blocked.length > 0 ? (
          <section>
            <h3 className="mb-1 text-xs font-semibold text-fg-muted">Blocked by its network rules</h3>
            <ul className="flex flex-col gap-1">
              {researcher.blocked.map((blocked) => (
                <li key={blocked.host} className="flex items-center gap-1.5 text-fg-danger">
                  <ShieldXIcon size={14} />
                  <span className="font-mono text-xs">{blocked.host}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {researcher.error ? <div className="flash flash-error">{researcher.error}</div> : null}
        {researcher.report ? (
          <section>
            <h3 className="mb-1 text-xs font-semibold text-fg-muted">Findings it reported</h3>
            <ReportMarkdown source={researcher.report} className="markdown-body--sm rounded-md border border-line-muted p-3" />
          </section>
        ) : null}
        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer select-none">Sandbox details</summary>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
            {[
              ["Worker", researcher.id],
              ["Session", researcher.workerId],
              ["Sandbox", researcher.sandboxId],
              ["Environment", researcher.environment],
              ["Model", researcher.model],
            ].map(([label, value]) =>
              value ? (
                <div key={label} className="contents">
                  <dt>{label}</dt>
                  <dd className="truncate font-mono text-fg" title={value}>
                    {value}
                  </dd>
                </div>
              ) : null,
            )}
          </dl>
        </details>
      </div>
    </dialog>
  );
}
