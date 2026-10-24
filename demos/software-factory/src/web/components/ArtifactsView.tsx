import type { LucideIcon } from "lucide-react";
import {
  Braces,
  ChevronRight,
  Download,
  ExternalLink,
  File,
  FileArchive,
  FileCode,
  FileDiff,
  FileText,
  FlaskConical,
  Folder,
  FolderOpen,
  FolderSearch,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { ArtifactFileView, ArtifactIndex, ArtifactVersionView, WorkOrder } from "../../shared/types.js";
import { artifactContentUrl } from "../lib/api.js";
import {
  artifactKey,
  basename,
  buildTree,
  defaultArtifact,
  groupArtifacts,
  pickReleaseArtifact,
  stationDefaultArtifact,
  useArtifactContent,
  viewerKind,
  type ArtifactGroup,
  type ArtifactPick,
  type TreeFolder,
} from "../lib/artifacts.js";
import { cx } from "../lib/cx.js";
import { formatBytes, formatFullDateTime, formatRelative, pluralize } from "../lib/format.js";
import { navigate, workOrderHref, type Query } from "../lib/router.js";
import { KIND_ICONS } from "../lib/stations.js";
import { ensureArtifacts, useArtifactIndex } from "../lib/store.js";
import { useNow } from "../lib/time.js";
import { Button, buttonClass } from "./ui/Button.js";
import { Callout, EmptyState, Skeleton } from "./ui/Feedback.js";
import { FileViewer } from "./viewers/FileViewer.js";

const PICKS: readonly ArtifactPick[] = ["readme", "test-report", "patch", "notes"];

function resolveFile(index: ArtifactIndex, workOrder: WorkOrder, query: Query): ArtifactFileView | undefined {
  if (query.station && query.path) {
    const exact = index.files.find((file) => file.stationId === query.station && file.path === query.path);
    if (exact) return exact;
  }
  const pick = PICKS.find((candidate) => candidate === query.pick);
  if (pick) {
    const picked = pickReleaseArtifact(index, workOrder, pick);
    if (picked) return picked;
  }
  if (query.station) {
    const first = stationDefaultArtifact(index, query.station);
    if (first) return first;
  }
  return defaultArtifact(index, workOrder);
}

function fileIcon(file: Pick<ArtifactFileView, "path" | "viewable">): LucideIcon {
  switch (viewerKind(file)) {
    case "diff":
      return FileDiff;
    case "test-report":
      return FlaskConical;
    case "markdown":
      return FileText;
    case "json":
      return Braces;
    case "code":
      return FileCode;
    default:
      return /\.(zip|tgz|tar|gz)$/i.test(file.path) ? FileArchive : File;
  }
}

export function ArtifactsView({ workOrder, query }: { readonly workOrder: WorkOrder; readonly query: Query }) {
  const resource = useArtifactIndex(workOrder.id);
  const index = resource?.data;

  if (!index) {
    if (resource?.error) {
      return (
        <Callout
          tone="danger"
          title="Couldn't load artifacts"
          actions={
            <Button size="sm" onClick={() => ensureArtifacts(workOrder.id, true)}>
              Retry
            </Button>
          }
        >
          {resource.error.message}
        </Callout>
      );
    }
    return <ArtifactsSkeleton />;
  }

  if (index.files.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30">
        <EmptyState icon={FolderSearch} title="No artifacts yet">
          Stations publish their code, patches, and test reports here as they finish.
        </EmptyState>
      </div>
    );
  }

  return <ArtifactsBrowser workOrder={workOrder} index={index} query={query} />;
}

function ArtifactsBrowser({ workOrder, index, query }: { readonly workOrder: WorkOrder; readonly index: ArtifactIndex; readonly query: Query }) {
  const groups = useMemo(() => groupArtifacts(index, workOrder), [index, workOrder]);
  const selected = resolveFile(index, workOrder, query);
  const requestedVersion = query.version ? Number(query.version) : undefined;
  const version = selected?.versions.find((candidate) => candidate.version === requestedVersion) ?? selected?.versions[0];
  const selectedKey = selected ? artifactKey(selected) : undefined;

  const select = (file: ArtifactFileView, versionNumber?: number): void =>
    navigate(workOrderHref(workOrder.id, "artifacts", { station: file.stationId, path: file.path, version: versionNumber }), {
      replace: true,
    });

  return (
    <div className="grid gap-4 lg:h-full lg:min-h-0 lg:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)]">
      <nav
        aria-label="Artifact files"
        className="max-h-80 min-w-0 overflow-y-auto rounded-2xl border border-zinc-800/80 bg-zinc-900/40 py-1 lg:max-h-none lg:min-h-0"
      >
        {groups.map((group) => (
          <GroupTree key={group.stationId} group={group} selectedKey={selectedKey} onSelect={(file) => select(file)} />
        ))}
      </nav>
      <section className="flex min-h-[28rem] min-w-0 flex-col overflow-clip rounded-2xl border border-zinc-800/80 bg-zinc-900/40 lg:min-h-0">
        {selected && version ? (
          <Viewer
            workOrder={workOrder}
            file={selected}
            version={version}
            stationTitle={groups.find((group) => group.stationId === selected.stationId)?.title}
            onVersion={(next) => select(selected, next === selected.versions[0]?.version ? undefined : next)}
          />
        ) : (
          <EmptyState icon={FileText} title="Pick a file">
            Choose a file on the left to preview it.
          </EmptyState>
        )}
      </section>
    </div>
  );
}

function ArtifactsSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)]" role="status" aria-label="Loading artifacts">
      <div className="space-y-2.5 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-4">
        {[60, 80, 70, 50, 75, 65].map((width, index) => (
          <div key={index} style={{ width: `${width}%` }}>
            <Skeleton className="h-3.5 w-full" />
          </div>
        ))}
      </div>
      <div className="space-y-2 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-4">
        <Skeleton className="h-5 w-1/3" />
        {[90, 70, 85, 60, 95, 40, 75].map((width, index) => (
          <div key={index} style={{ width: `${width}%` }}>
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function GroupTree({
  group,
  selectedKey,
  onSelect,
}: {
  readonly group: ArtifactGroup;
  readonly selectedKey?: string;
  readonly onSelect: (file: ArtifactFileView) => void;
}) {
  const tree = useMemo(() => buildTree(group.files), [group.files]);
  const Icon = group.station ? KIND_ICONS[group.station.kind] : Folder;
  return (
    <div className="py-1.5">
      <div className="sticky top-0 z-[1] flex items-center gap-2 bg-zinc-900/95 px-3 py-1.5 backdrop-blur">
        <Icon className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
        <span className="truncate text-xs font-semibold text-zinc-300">{group.title}</span>
        <span className="ml-auto shrink-0 text-[11px] text-zinc-600 tabular">{group.files.length}</span>
      </div>
      <FolderChildren folder={tree} depth={0} selectedKey={selectedKey} onSelect={onSelect} />
    </div>
  );
}

function FolderChildren({
  folder,
  depth,
  selectedKey,
  onSelect,
}: {
  readonly folder: TreeFolder;
  readonly depth: number;
  readonly selectedKey?: string;
  readonly onSelect: (file: ArtifactFileView) => void;
}) {
  return (
    <ul>
      {folder.folders.map((child) => (
        <FolderItem key={child.path} folder={child} depth={depth} selectedKey={selectedKey} onSelect={onSelect} />
      ))}
      {folder.files.map((file) => (
        <FileItem key={file.path} file={file} depth={depth} selected={artifactKey(file) === selectedKey} onSelect={onSelect} />
      ))}
    </ul>
  );
}

function FolderItem({
  folder,
  depth,
  selectedKey,
  onSelect,
}: {
  readonly folder: TreeFolder;
  readonly depth: number;
  readonly selectedKey?: string;
  readonly onSelect: (file: ArtifactFileView) => void;
}) {
  const [open, setOpen] = useState(true);
  // Compact single-child chains like VS Code: "files/src".
  let target = folder;
  let label = folder.name;
  while (target.files.length === 0 && target.folders.length === 1 && target.folders[0]) {
    target = target.folders[0];
    label = `${label}/${target.name}`;
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={{ paddingLeft: 10 + depth * 14 }}
        className="flex w-full items-center gap-1.5 py-1 pr-3 text-left text-[12.5px] text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
      >
        <ChevronRight className={cx("size-3 shrink-0 text-zinc-600 transition-transform", open && "rotate-90")} aria-hidden />
        {open ? (
          <FolderOpen className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
        ) : (
          <Folder className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
        )}
        <span className="truncate font-mono text-[12px]">{label}</span>
      </button>
      {open ? <FolderChildren folder={target} depth={depth + 1} selectedKey={selectedKey} onSelect={onSelect} /> : null}
    </li>
  );
}

function FileItem({
  file,
  depth,
  selected,
  onSelect,
}: {
  readonly file: ArtifactFileView;
  readonly depth: number;
  readonly selected: boolean;
  readonly onSelect: (file: ArtifactFileView) => void;
}) {
  const Icon = fileIcon(file);
  const versions = file.versions.length;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(file)}
        aria-current={selected ? "true" : undefined}
        title={file.path}
        style={{ paddingLeft: 10 + depth * 14 + 16 }}
        className={cx(
          "relative flex w-full items-center gap-1.5 py-1 pr-3 text-left text-[12.5px] transition-colors",
          selected ? "bg-amber-400/10 text-zinc-50" : "text-zinc-300 hover:bg-zinc-800/50",
        )}
      >
        {selected ? <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-amber-400" aria-hidden /> : null}
        <Icon className={cx("size-3.5 shrink-0", selected ? "text-amber-300" : "text-zinc-500")} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{basename(file.path)}</span>
        {versions > 1 ? (
          <span
            className="shrink-0 rounded-full bg-zinc-800 px-1.5 text-[10px] leading-4 font-medium text-zinc-400 ring-1 ring-inset ring-white/5"
            title={pluralize(versions, "version")}
          >
            {versions}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function versionLabel(version: ArtifactVersionView, now: number): string {
  return `v${version.version} · round ${version.round} · ${formatBytes(version.size)} · ${formatRelative(version.publishedAt, now)}`;
}

function Viewer({
  workOrder,
  file,
  version,
  stationTitle,
  onVersion,
}: {
  readonly workOrder: WorkOrder;
  readonly file: ArtifactFileView;
  readonly version: ArtifactVersionView;
  readonly stationTitle?: string;
  readonly onVersion: (version: number) => void;
}) {
  const now = useNow(30_000);
  const { content, retry } = useArtifactContent(workOrder.id, file, version);
  const url = artifactContentUrl(workOrder.id, file.stationId, file.path, version.version);
  const Icon = fileIcon(file);

  let body: ReactNode;
  if (!file.viewable) {
    body = (
      <EmptyState
        icon={FileArchive}
        title="This file can't be previewed"
        action={
          <a href={url} download={basename(file.path)} className={buttonClass("secondary", "md")}>
            <Download className="size-4" aria-hidden />
            Download {basename(file.path)}
          </a>
        }
      >
        {formatBytes(version.size)} · {file.contentType}
      </EmptyState>
    );
  } else if (content.status === "ready") {
    body = <FileViewer key={`${file.stationId}:${file.path}:${version.version}`} path={file.path} text={content.text} />;
  } else if (content.status === "error") {
    body = (
      <Callout
        tone="danger"
        className="m-4"
        title="Couldn't load this file"
        actions={
          <Button size="sm" onClick={retry}>
            Retry
          </Button>
        }
      >
        {content.message}
      </Callout>
    );
  } else {
    body = (
      <div className="space-y-2 p-4" role="status" aria-label="Loading file">
        {[85, 60, 92, 45, 70, 80, 55, 88].map((width, index) => (
          <div key={index} style={{ width: `${width}%` }}>
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-800/80 bg-zinc-900/70 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Icon className="size-4 shrink-0 text-zinc-500" aria-hidden />
          <div className="min-w-0">
            <h2 className="truncate font-mono text-[13px] font-medium text-zinc-100" title={file.path}>
              {file.path}
            </h2>
            {stationTitle ? <p className="truncate text-[11px] text-zinc-500">{stationTitle}</p> : null}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {file.versions.length > 1 ? (
            <label className="relative">
              <span className="sr-only">Version</span>
              <select
                value={version.version}
                onChange={(event) => onVersion(Number(event.target.value))}
                className="h-7 max-w-[17rem] appearance-none truncate rounded-md bg-zinc-800/80 pr-7 pl-2.5 text-xs text-zinc-200 ring-1 ring-inset ring-white/10 hover:bg-zinc-700/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
              >
                {file.versions.map((candidate) => (
                  <option key={candidate.version} value={candidate.version}>
                    {versionLabel(candidate, now)}
                  </option>
                ))}
              </select>
              <ChevronRight className="pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2 rotate-90 text-zinc-500" aria-hidden />
            </label>
          ) : (
            <span className="text-xs text-zinc-500" title={formatFullDateTime(version.publishedAt)}>
              {versionLabel(version, now)}
            </span>
          )}
          <a href={url} target="_blank" rel="noreferrer" className={buttonClass("ghost", "sm")}>
            <ExternalLink className="size-3.5" aria-hidden />
            Raw
          </a>
          <a
            href={url}
            download={basename(file.path)}
            className={buttonClass("ghost", "sm", "w-7 px-0")}
            aria-label={`Download ${basename(file.path)}`}
            title="Download"
          >
            <Download className="size-3.5" aria-hidden />
          </a>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </>
  );
}
