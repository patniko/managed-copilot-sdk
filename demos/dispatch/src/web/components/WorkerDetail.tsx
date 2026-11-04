import { FileIcon, PackageDependentsIcon, SyncIcon, TerminalIcon, XIcon } from "@primer/octicons-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Blueprint, CommandRecord, ConversationView, FileView, WorkerView } from "../../shared/types.js";
import { api, errorMessage } from "../lib/api.js";
import { networkSummary, sizeSummary } from "../lib/blueprints.js";
import { blueprintFor, kindOf, workGiven, type WorkItem } from "../lib/conversation.js";
import { cx } from "../lib/cx.js";
import { formatBytes, formatClock, formatRelative } from "../lib/format.js";
import { conversationHref, navigate, type ConversationTab } from "../lib/router.js";
import { openInCli, useStore } from "../lib/store.js";
import { toast } from "../lib/toast.js";
import { BlueprintIcon } from "./BlueprintIcon.js";
import { AgentChip } from "./Commands.js";
import { FileDialog } from "./FileDialog.js";
import { MarkdownView } from "./Markdown.js";
import { commandsIn, handsTitle, STATE_WORD, StateIcon } from "./Sandboxes.js";
import { IconButton } from "./ui/Button.js";
import { CopyButton } from "./ui/CopyButton.js";
import { Callout } from "./ui/Feedback.js";

const FILES_SHOWN = 12;

function Heading({ children, action }: { readonly children: ReactNode; readonly action?: ReactNode }) {
  return (
    <div className="flex min-h-6 items-center gap-2">
      <h4 className="text-xs font-semibold text-fg-muted">{children}</h4>
      {action ? <span className="ml-auto">{action}</span> : null}
    </div>
  );
}

/** The work given to a worker, clamped to its first three lines of text (across tasks) with "Show all". */
function WorkList({ items }: { readonly items: readonly WorkItem[] }) {
  const list = useRef<HTMLOListElement>(null);
  const [open, setOpen] = useState(false);
  // The height that shows exactly three lines, when there's more than that.
  const [limit, setLimit] = useState<number>();
  const measure = useCallback((): void => {
    const element = list.current;
    if (!element) return;
    const line = Number.parseFloat(getComputedStyle(element).lineHeight) || 20;
    const top = element.getBoundingClientRect().top;
    let seen = 0;
    let height: number | undefined;
    for (const item of Array.from(element.children)) {
      const box = item.getBoundingClientRect();
      const lines = Math.max(1, Math.round(box.height / line));
      if (seen + lines >= 3) {
        height = Math.round(box.top - top + (3 - seen) * line);
        break;
      }
      seen += lines;
    }
    setLimit(height !== undefined && element.scrollHeight > height + 1 ? height : undefined);
  }, []);
  useLayoutEffect(measure);
  // Tasks wrap differently when the pane's width changes.
  useEffect(() => {
    const element = list.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);
  const clamped = limit !== undefined && !open;
  return (
    <>
      <ol ref={list} className={cx("flex flex-col gap-1 text-sm leading-5", clamped && "overflow-hidden")} style={clamped ? { maxHeight: limit } : undefined}>
        {items.map((item) => (
          <li key={`${item.kind}-${item.at}`} className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-2">
            <span className={cx("Label justify-center tabular-nums", item.kind === "create" ? "Label--success" : "Label--accent")} title={item.kind === "create" ? "Its first task" : "A follow-up"}>
              {item.index > 0 ? `#${item.index}` : "task"}
            </span>
            <span>{item.task}</span>
          </li>
        ))}
      </ol>
      {limit !== undefined ? (
        <button type="button" className="Link mt-1 text-xs" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? "Show less" : "Show all"}
        </button>
      ) : null}
    </>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

export function WorkerDetail({ view, worker, blueprints, tab }: { readonly view: ConversationView; readonly worker: WorkerView; readonly blueprints: readonly Blueprint[]; readonly tab: ConversationTab }) {
  const canLaunch = useStore((state) => state.canLaunchTerminal);
  const [preview, setPreview] = useState<string>();
  const [files, setFiles] = useState<{ files: readonly FileView[]; at: string }>();
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const section = useRef<HTMLElement>(null);
  const blueprint = blueprintFor(worker.environment, blueprints);
  const kind = kindOf(worker.environment, blueprints);
  const hands = worker.role === "hands";
  const title = hands ? handsTitle(view, worker) : worker.name;
  const listed = files && (!worker.filesAt || files.at >= worker.filesAt) ? files.files : (worker.files ?? []);
  const listedAt = files && (!worker.filesAt || files.at >= worker.filesAt) ? files.at : worker.filesAt;
  const stopped = worker.state === "stopped";
  const attach = view.attachCommand.replace(view.id, worker.id);
  const outputs = new Set(worker.outputs.map((output) => `outputs/${output}`));

  // Bring the details into view when a sandbox is picked.
  useEffect(() => {
    section.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      setFiles(await api.files(view.id, worker.id));
    } catch (error) {
      toast.error("Couldn't list the files", errorMessage(error));
    } finally {
      setRefreshing(false);
    }
  };

  const shown = showAll ? listed : listed.slice(0, FILES_SHOWN);
  return (
    <section ref={section} aria-label={`${title} details`} className="scroll-mt-3 rounded-lg border border-line bg-canvas">
      <header className="flex min-h-11 items-center gap-2 border-b border-line-muted py-1.5 pr-1.5 pl-3">
        <BlueprintIcon kind={kind} />
        <h3 className="min-w-0 truncate text-sm font-semibold">{title}</h3>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
          <StateIcon state={worker.state} />
          {hands && worker.state === "working" ? "Running" : STATE_WORD[worker.state]}
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          {!hands && !stopped ? (
            canLaunch ? (
              <IconButton icon={TerminalIcon} label="Open in Copilot CLI" size="sm" onClick={() => void openInCli(worker.id)} />
            ) : (
              <CopyButton text={attach} label="Copy the command that opens it in Copilot CLI" variant="invisible" />
            )
          ) : null}
          <IconButton icon={XIcon} label="Close" size="sm" onClick={() => navigate(conversationHref(view.id, { tab }), { replace: true })} />
        </span>
      </header>
      <div className="flex flex-col gap-4 p-3">
        {hands ? (
          <HandsCommands view={view} worker={worker} />
        ) : (
          <div>
            <Heading>Work it was given</Heading>
            <div className="mt-1">
              <WorkList items={workGiven(view, worker)} />
            </div>
          </div>
        )}
        {worker.error ? (
          <Callout tone="danger" compact>
            {worker.error}
          </Callout>
        ) : null}
        {worker.result ? (
          <div>
            <Heading>Its report</Heading>
            <div className="mt-1 max-h-64 overflow-y-auto rounded-md border border-line-muted bg-canvas-muted px-3 py-2">
              <MarkdownView source={worker.result} />
            </div>
          </div>
        ) : null}
        <div>
          <Heading
            action={
              !stopped ? (
                <IconButton icon={SyncIcon} label={listedAt ? `List the files again (listed ${formatRelative(listedAt, Date.now())})` : "List the files"} size="sm" onClick={() => void refresh()} disabled={refreshing} />
              ) : undefined
            }
          >
            Files
          </Heading>
          {stopped ? (
            <p className="mt-1 text-sm text-fg-muted">Deleted with its sandbox.</p>
          ) : listed.length === 0 ? (
            <p className="mt-1 text-sm text-fg-muted">{listedAt ? "No files yet." : "Files appear here while it works."}</p>
          ) : (
            <ul className="mt-1 flex flex-col text-sm">
              {shown.map((file) => (
                <li key={file.path}>
                  <button type="button" onClick={() => setPreview(file.path)} className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-canvas-muted">
                    {outputs.has(file.path) ? <PackageDependentsIcon size={14} className="shrink-0 text-fg-done" aria-label="Published output" /> : <FileIcon size={14} className="shrink-0 text-fg-muted" />}
                    <span className="min-w-0 truncate font-mono text-xs" title={file.path}>
                      {file.path}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-fg-muted tabular-nums">{formatBytes(file.size)}</span>
                  </button>
                </li>
              ))}
              {listed.length > FILES_SHOWN ? (
                <li>
                  <button type="button" className="Link mt-1 px-1 text-xs" onClick={() => setShowAll((value) => !value)}>
                    {showAll ? "Show fewer" : `Show all ${listed.length} files`}
                  </button>
                </li>
              ) : null}
            </ul>
          )}
        </div>
        <details>
          <summary className="cursor-pointer text-xs font-semibold text-fg-muted select-none hover:text-fg">Details</summary>
          <dl className="mt-2 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            <Fact label="Blueprint">
              {blueprint?.label ?? "Sandbox"} <span className="font-mono text-xs text-fg-muted">{worker.environment}</span>
            </Fact>
            {blueprint ? <Fact label="Size">{sizeSummary(blueprint)}</Fact> : null}
            {blueprint ? (
              <Fact label="Network">
                <span title={blueprint.network.hosts.join("\n") || undefined}>{networkSummary(blueprint.network, blueprint.kind)}</span>
              </Fact>
            ) : null}
            <Fact label="Sandbox">
              {worker.sandbox ? (
                <span className="inline-flex max-w-full items-center gap-1">
                  <span className="truncate font-mono text-xs">{worker.sandbox.id}</span>
                  <CopyButton text={worker.sandbox.id} label="Copy sandbox ID" />
                  {worker.sandbox.state ? <span className="text-xs text-fg-muted">{worker.sandbox.state}</span> : null}
                </span>
              ) : (
                <span className="text-fg-muted">{worker.state === "starting" ? "Being prepared…" : "Not reported"}</span>
              )}
            </Fact>
            {worker.model && !hands ? <Fact label="Model">{worker.model}</Fact> : null}
            <Fact label="Created">
              {formatClock(worker.createdAt)}
              {worker.createdBy !== undefined ? <span className="text-fg-muted"> · message #{worker.createdBy}</span> : null}
            </Fact>
            {!hands && !stopped ? (
              <Fact label="Copilot CLI">
                <span className="inline-flex max-w-full items-center gap-1">
                  <code className="truncate font-mono text-xs">{attach}</code>
                  <CopyButton text={attach} label="Copy the attach command" />
                </span>
              </Fact>
            ) : null}
          </dl>
        </details>
      </div>
      {preview ? <FileDialog conversationId={view.id} workerId={worker.id} path={preview} onClose={() => setPreview(undefined)} /> : null}
    </section>
  );
}

/** Every command run in a hands sandbox, as the platform recorded it (`managed.exec.list`), with who ran it. */
function HandsCommands({ view, worker }: { readonly view: ConversationView; readonly worker: WorkerView }) {
  const [commands, setCommands] = useState<readonly CommandRecord[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  // Changes whenever a command in this sandbox starts or ends, so the list follows each one to its outcome.
  const known = commandsIn(view, worker)
    .map((command) => `${command.id}:${command.status}`)
    .join(",");
  const stopped = worker.state === "stopped";
  const running = commands?.some((command) => command.state === "running") ?? false;

  const load = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    setLoading(true);
    try {
      const listed = await api.commands(view.id, worker.id);
      // A slower, older answer never replaces a newer one.
      if (request !== latest.current) return;
      setCommands(listed);
      setError(undefined);
    } catch (failure) {
      if (request === latest.current) setError(errorMessage(failure));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [view.id, worker.id]);

  useEffect(() => {
    if (!stopped) void load();
  }, [load, known, stopped]);

  // Background commands can run on after their call returned: keep listing while any does.
  useEffect(() => {
    if (stopped || !running) return;
    const timer = setInterval(() => void load(), 4_000);
    return () => clearInterval(timer);
  }, [load, running, stopped]);

  return (
    <div>
      <Heading action={!stopped ? <IconButton icon={SyncIcon} label="List the commands again" size="sm" onClick={() => void load()} disabled={loading} /> : undefined}>Commands run here</Heading>
      {stopped ? (
        <p className="mt-1 text-sm text-fg-muted">Deleted, with its list of commands.</p>
      ) : error ? (
        <Callout tone="warning" compact className="mt-1">
          {error}
        </Callout>
      ) : !commands ? (
        <div className="SkeletonBox mt-1 h-16" aria-busy="true" />
      ) : commands.length === 0 ? (
        <p className="mt-1 text-sm text-fg-muted">No commands yet.</p>
      ) : (
        <ol className="mt-1 flex max-h-72 flex-col overflow-y-auto rounded-md border border-line-muted text-sm">
          {commands.map((command) => (
            <li key={command.id} className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_auto] items-center gap-2 border-t border-line-muted px-2 py-1 first:border-t-0" title={command.command}>
              {command.tool === "api" ? <span className="text-xs text-fg-muted">managed.exec</span> : <AgentChip view={view} agentId={command.agentId} />}
              <span className="min-w-0 truncate font-mono text-xs">$ {command.command.replace(/\s+/g, " ")}</span>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
                {formatClock(command.startedAt)}
                {command.state === "running" ? (
                  <span className="Label Label--accent">running</span>
                ) : command.exitCode !== undefined ? (
                  <span className={command.exitCode === 0 ? "Label Label--success" : "Label Label--danger"}>exit {command.exitCode}</span>
                ) : (
                  <span className="Label Label--secondary">{command.state.replace("_", " ")}</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
