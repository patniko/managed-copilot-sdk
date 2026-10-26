import {
  ChevronRightIcon,
  DownloadIcon,
  FileDirectoryFillIcon,
  FileDirectoryIcon,
  FileDirectoryOpenFillIcon,
  FileIcon,
  FileZipIcon,
  LinkExternalIcon,
} from "@primer/octicons-react";
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
import { Callout, EmptyState } from "./ui/Feedback.js";
import { Tooltip } from "./ui/Tooltip.js";
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

/** Folder icons use the tree view's own color, as on github.com. */
const FOLDER_ICON = "shrink-0 text-[color:var(--treeViewItem-leadingVisual-iconColor-rest)]";

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
      <div className="Box">
        <EmptyState icon={FileDirectoryIcon} title="No artifacts yet" size="lg">
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
      <nav aria-label="Artifact files" className="Box max-h-80 min-w-0 overflow-y-auto pb-2 lg:max-h-none lg:min-h-0">
        {groups.map((group) => (
          <GroupTree key={group.stationId} group={group} selectedKey={selectedKey} onSelect={(file) => select(file)} />
        ))}
      </nav>
      <section className="Box flex min-h-[28rem] min-w-0 flex-col overflow-clip lg:min-h-0">
        {selected && version ? (
          <Viewer
            workOrder={workOrder}
            file={selected}
            version={version}
            stationTitle={groups.find((group) => group.stationId === selected.stationId)?.title}
            onVersion={(next) => select(selected, next === selected.versions[0]?.version ? undefined : next)}
          />
        ) : (
          <EmptyState icon={FileIcon} title="Pick a file">
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
      <div className="Box space-y-3 p-4">
        {[60, 80, 70, 50, 75, 65].map((width, index) => (
          <div key={index} className="SkeletonText" style={{ width: `${width}%` }} />
        ))}
      </div>
      <div className="Box overflow-hidden">
        <div className="file-header">
          <div className="SkeletonText w-1/3" />
        </div>
        <div className="space-y-2 p-4">
          {[90, 70, 85, 60, 95, 40, 75].map((width, index) => (
            <div key={index} className="SkeletonText" style={{ width: `${width}%` }} />
          ))}
        </div>
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
  const Glyph = group.station ? KIND_ICONS[group.station.kind] : FileDirectoryIcon;
  return (
    <div>
      <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-line-muted bg-canvas px-3 py-2">
        <Glyph size={16} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-fg-muted">{group.title}</span>
        <span className="Counter">{group.files.length}</span>
      </div>
      <div className="px-2 py-1">
        <FolderChildren folder={tree} depth={0} selectedKey={selectedKey} onSelect={onSelect} />
      </div>
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

const ROW = "relative flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left hover:bg-control-transparent-hover";

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
  // Compact single-child chains like github.com's file tree: "files/src".
  let target = folder;
  let label = folder.name;
  while (target.files.length === 0 && target.folders.length === 1 && target.folders[0]) {
    target = target.folders[0];
    label = `${label}/${target.name}`;
  }
  const Glyph = open ? FileDirectoryOpenFillIcon : FileDirectoryFillIcon;
  return (
    <li>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} style={{ paddingLeft: 4 + depth * 16 }} className={ROW}>
        <ChevronRightIcon size={16} className={cx("shrink-0 text-fg-muted transition-transform duration-100", open && "rotate-90")} />
        <Glyph size={16} className={FOLDER_ICON} />
        <span className="truncate">{label}</span>
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
  const versions = file.versions.length;
  const Glyph = file.viewable ? FileIcon : FileZipIcon;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(file)}
        aria-current={selected ? "true" : undefined}
        title={file.path}
        style={{ paddingLeft: 4 + depth * 16 + 24 }}
        className={cx(ROW, selected && "bg-control-transparent-selected font-semibold")}
      >
        {selected ? <span className="absolute top-1/2 left-0 h-5 w-1 -translate-y-1/2 rounded-md bg-line-accent" aria-hidden /> : null}
        <Glyph size={16} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate">{basename(file.path)}</span>
        {versions > 1 ? (
          <Tooltip content={pluralize(versions, "version")}>
            <span className="Counter font-normal">{versions}</span>
          </Tooltip>
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

  let body: ReactNode;
  if (!version.viewable) {
    // The factory keeps text files up to 1 MB; it has no bytes to serve for anything else.
    body = (
      <EmptyState icon={FileZipIcon} title="This file can't be previewed" size="lg">
        {formatBytes(version.size)} · {file.contentType}. The factory keeps text files up to 1 MB, so binary and larger outputs
        aren't stored here.
      </EmptyState>
    );
  } else if (content.status === "ready") {
    body = <FileViewer key={`${file.stationId}:${file.path}:${version.version}`} path={file.path} text={content.text} />;
  } else if (content.status === "error") {
    body = (
      <Callout
        tone="danger"
        compact
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
          <div key={index} className="SkeletonText" style={{ width: `${width}%` }} />
        ))}
      </div>
    );
  }

  return (
    <>
      <header className="file-header flex-wrap gap-y-1.5 rounded-t-md">
        <div className="min-w-0 flex-1 basis-60">
          <h2 className="truncate font-semibold" title={file.path}>
            {file.path}
          </h2>
          {stationTitle ? <p className="truncate font-sans text-xs text-fg-muted">{stationTitle}</p> : null}
        </div>
        <div className="flex items-center gap-2 font-sans">
          {file.versions.length > 1 ? (
            <label className="min-w-0">
              <span className="sr-only">Version</span>
              <select
                value={version.version}
                onChange={(event) => onVersion(Number(event.target.value))}
                className="form-select input-sm max-w-[17rem] truncate"
              >
                {file.versions.map((candidate) => (
                  <option key={candidate.version} value={candidate.version}>
                    {versionLabel(candidate, now)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="text-xs text-fg-muted" title={formatFullDateTime(version.publishedAt)}>
              {versionLabel(version, now)}
            </span>
          )}
          {version.viewable ? (
            <>
              <a href={url} target="_blank" rel="noreferrer" className={buttonClass("default", "sm")}>
                <LinkExternalIcon size={16} />
                Raw
              </a>
              <Tooltip content="Download">
                <a href={url} download={basename(file.path)} className={buttonClass("default", "sm", "btn-icon")} aria-label={`Download ${basename(file.path)}`}>
                  <DownloadIcon size={16} />
                </a>
              </Tooltip>
            </>
          ) : null}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </>
  );
}
