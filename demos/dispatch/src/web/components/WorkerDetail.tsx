import { FileIcon, PackageDependentsIcon, SyncIcon, TerminalIcon, XIcon } from "@primer/octicons-react";
import { useState, type ReactNode } from "react";
import { BLUEPRINT_LABELS } from "../../shared/catalog.js";
import type { Blueprint, ConversationView, FileView, WorkerView } from "../../shared/types.js";
import { api, errorMessage } from "../lib/api.js";
import { networkSummary, sizeSummary, WORKER_STATE } from "../lib/blueprints.js";
import { blueprintFor, workGiven } from "../lib/conversation.js";
import { formatBytes, formatClock, formatRelative } from "../lib/format.js";
import { conversationHref, navigate } from "../lib/router.js";
import { openInCli, useStore } from "../lib/store.js";
import { toast } from "../lib/toast.js";
import { WorkerStateIcon } from "./Environments.js";
import { FileDialog } from "./FileDialog.js";
import { MarkdownView } from "./Markdown.js";
import { Button, IconButton } from "./ui/Button.js";
import { CopyButton } from "./ui/CopyButton.js";
import { Callout } from "./ui/Feedback.js";

const FILES_SHOWN = 14;

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

export function WorkerDetail({ view, worker, blueprints }: { readonly view: ConversationView; readonly worker: WorkerView; readonly blueprints: readonly Blueprint[] }) {
  const canLaunch = useStore((state) => state.canLaunchTerminal);
  const [preview, setPreview] = useState<string>();
  const [files, setFiles] = useState<{ files: readonly FileView[]; at: string }>();
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const blueprint = blueprintFor(worker.environment, blueprints);
  const work = workGiven(view, worker);
  const listed = files && (!worker.filesAt || files.at >= worker.filesAt) ? files.files : (worker.files ?? []);
  const listedAt = files && (!worker.filesAt || files.at >= worker.filesAt) ? files.at : worker.filesAt;
  const stopped = worker.state === "stopped";
  const meta = WORKER_STATE[worker.state];
  const attach = view.attachCommand.replace(view.id, worker.id);

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
    <section aria-label={`${worker.name} details`} className="rounded-lg border border-line bg-canvas">
      <header className="flex items-center gap-2 border-b border-line-muted px-3 py-2">
        <WorkerStateIcon worker={worker} size={16} />
        <h3 className="text-sm font-semibold">{worker.name}</h3>
        <span className="text-xs text-fg-muted">
          {meta.label} · {meta.sandbox}
        </span>
        <span className="ml-auto" />
        <IconButton icon={XIcon} label="Close details" size="sm" onClick={() => navigate(conversationHref(view.id), { replace: true })} />
      </header>
      <div className="grid gap-4 p-3 lg:grid-cols-2">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Sandbox</h4>
          <dl className="mt-1.5 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            <Fact label="Blueprint">
              <span className="font-mono text-xs">{worker.environment}</span>
              {blueprint ? <span className="text-fg-muted"> · {BLUEPRINT_LABELS[blueprint.kind]}</span> : null}
            </Fact>
            {blueprint ? <Fact label="Size">{sizeSummary(blueprint)}</Fact> : null}
            {blueprint ? <Fact label="Network">{blueprint.network.access === "restricted" ? <span title={blueprint.network.hosts.join("\n")}>{networkSummary(blueprint.network, blueprint.kind)}</span> : networkSummary(blueprint.network, blueprint.kind)}</Fact> : null}
            <Fact label="Sandbox">
              {worker.sandbox ? (
                <span className="inline-flex max-w-full items-center gap-1">
                  <span className="truncate font-mono text-xs">{worker.sandbox.id}</span>
                  <CopyButton text={worker.sandbox.id} label="Copy sandbox ID" />
                  {worker.sandbox.state ? <span className="ml-1 text-xs text-fg-muted">{worker.sandbox.state}</span> : null}
                </span>
              ) : (
                <span className="text-fg-muted">{worker.state === "starting" ? "Being prepared…" : "Not reported"}</span>
              )}
            </Fact>
            <Fact label="Created">
              {formatClock(worker.createdAt)}
              {worker.createdBy !== undefined ? <span className="text-fg-muted"> · for message #{worker.createdBy}</span> : null}
            </Fact>
            {worker.model ? <Fact label="Model">{worker.model}</Fact> : null}
          </dl>

          <div className="mt-3 flex items-center gap-2">
            <h4 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Workspace</h4>
            {listedAt ? <span className="text-xs text-fg-muted">listed {formatRelative(listedAt, Date.now())}</span> : null}
            {!stopped ? <IconButton icon={SyncIcon} label="List the files again" size="sm" className="ml-auto" onClick={() => void refresh()} disabled={refreshing} /> : null}
          </div>
          {stopped ? (
            <p className="mt-1 text-sm text-fg-muted">Its sandbox was deleted with its files.</p>
          ) : listed.length === 0 ? (
            <p className="mt-1 text-sm text-fg-muted">{listedAt ? "No files yet." : "Files appear here while it works."}</p>
          ) : (
            <ul className="mt-1 flex flex-col text-sm">
              {shown.map((file) => (
                <li key={file.path}>
                  <button type="button" onClick={() => setPreview(file.path)} className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-canvas-muted">
                    <FileIcon size={14} className="shrink-0 text-fg-muted" />
                    <span className="min-w-0 truncate font-mono text-xs">{file.path}</span>
                    <span className="ml-auto shrink-0 text-xs text-fg-muted tabular-nums">{formatBytes(file.size)}</span>
                  </button>
                </li>
              ))}
              {listed.length > FILES_SHOWN ? (
                <li>
                  <button type="button" className="Link--muted mt-1 px-1 text-xs" onClick={() => setShowAll((value) => !value)}>
                    {showAll ? "Show fewer" : `Show all ${listed.length} files`}
                  </button>
                </li>
              ) : null}
            </ul>
          )}
          {worker.outputs.length ? (
            <>
              <h4 className="mt-3 text-xs font-semibold tracking-wide text-fg-muted uppercase">Published outputs</h4>
              <ul className="mt-1 flex flex-col text-sm">
                {worker.outputs.map((output) => (
                  <li key={output}>
                    <button type="button" disabled={stopped} onClick={() => setPreview(`outputs/${output}`)} className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-canvas-muted disabled:cursor-default">
                      <PackageDependentsIcon size={14} className="shrink-0 text-fg-done" />
                      <span className="min-w-0 truncate font-mono text-xs">outputs/{output}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>

        <div className="min-w-0">
          <h4 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Work it was given</h4>
          <ol className="mt-1.5 flex flex-col gap-1.5 text-sm">
            {work.map((item) => (
              <li key={`${item.kind}-${item.at}`} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-2">
                <span className={item.kind === "create" ? "Label Label--success justify-center" : "Label Label--accent justify-center"}>{item.index > 0 ? `#${item.index}` : "task"}</span>
                <span className="line-clamp-4" title={item.task}>
                  {item.task}
                </span>
              </li>
            ))}
          </ol>
          {worker.error ? (
            <Callout tone="danger" compact className="mt-3">
              {worker.error}
            </Callout>
          ) : null}
          {worker.result ? (
            <>
              <h4 className="mt-3 text-xs font-semibold tracking-wide text-fg-muted uppercase">Its latest report</h4>
              <div className="mt-1.5 max-h-72 overflow-y-auto rounded-md border border-line-muted bg-canvas-muted px-3 py-2">
                <MarkdownView source={worker.result} />
              </div>
            </>
          ) : null}
          {!stopped ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex min-w-0 flex-1 items-center gap-1 rounded-md border border-line bg-canvas-inset px-2 py-1">
                <TerminalIcon size={14} className="shrink-0 text-fg-muted" />
                <code className="truncate font-mono text-xs">{attach}</code>
                <CopyButton text={attach} label="Copy the attach command" />
              </span>
              {canLaunch ? (
                <Button size="sm" icon={TerminalIcon} onClick={() => void openInCli(worker.id)}>
                  Open in Copilot CLI
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {preview ? <FileDialog conversationId={view.id} workerId={worker.id} path={preview} onClose={() => setPreview(undefined)} /> : null}
    </section>
  );
}
