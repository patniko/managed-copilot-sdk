import { useCallback, useEffect, useState } from "react";
import type { ArtifactFileView, ArtifactIndex, ArtifactVersionView, Station, TestReport, WorkOrder } from "../../shared/types.js";
import { api, errorMessage } from "./api.js";
import { pipelineStations } from "./stations.js";

export type ViewerKind = "diff" | "test-report" | "markdown" | "json" | "code" | "binary";

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function viewerKind(file: Pick<ArtifactFileView, "path" | "viewable">): ViewerKind {
  if (!file.viewable) return "binary";
  const name = basename(file.path).toLowerCase();
  if (name.endsWith(".patch") || name.endsWith(".diff")) return "diff";
  if (name === "test-report.json") return "test-report";
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (name.endsWith(".json")) return "json";
  return "code";
}

export function artifactKey(file: Pick<ArtifactFileView, "stationId" | "path">): string {
  return `${file.stationId}\n${file.path}`;
}

export interface ArtifactGroup {
  readonly stationId: string;
  readonly station?: Station;
  readonly title: string;
  readonly files: readonly ArtifactFileView[];
}

/** Files grouped by station, in pipeline order. */
export function groupArtifacts(index: ArtifactIndex, workOrder: WorkOrder): ArtifactGroup[] {
  const byStation = new Map<string, ArtifactFileView[]>();
  for (const file of index.files) {
    const list = byStation.get(file.stationId) ?? [];
    list.push(file);
    byStation.set(file.stationId, list);
  }
  const groups: ArtifactGroup[] = [];
  for (const station of pipelineStations(workOrder)) {
    const files = byStation.get(station.id);
    if (!files) continue;
    groups.push({ stationId: station.id, station, title: station.title, files: sortByPath(files) });
    byStation.delete(station.id);
  }
  for (const [stationId, files] of byStation) groups.push({ stationId, title: stationId, files: sortByPath(files) });
  return groups;
}

function sortByPath(files: readonly ArtifactFileView[]): ArtifactFileView[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path));
}

export interface TreeFolder {
  readonly name: string;
  readonly path: string;
  readonly folders: TreeFolder[];
  readonly files: ArtifactFileView[];
}

export function buildTree(files: readonly ArtifactFileView[]): TreeFolder {
  const root: TreeFolder = { name: "", path: "", folders: [], files: [] };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      const path = folder.path ? `${folder.path}/${part}` : part;
      let child = folder.folders.find((candidate) => candidate.name === part);
      if (!child) {
        child = { name: part, path, folders: [], files: [] };
        folder.folders.push(child);
      }
      folder = child;
    }
    folder.files.push(file);
  }
  const sort = (folder: TreeFolder): void => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.files.sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
    folder.folders.forEach(sort);
  };
  sort(root);
  return root;
}

function releaseStationId(workOrder: WorkOrder): string {
  return workOrder.stations.find((station) => station.kind === "release")?.id ?? "release";
}

function shortestPath(files: readonly ArtifactFileView[]): ArtifactFileView | undefined {
  return [...files].sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.length - b.path.length)[0];
}

export type ArtifactPick = "readme" | "test-report" | "patch" | "notes";

/** Well-known release outputs, used by the Deliverable tab's buttons. */
export function pickReleaseArtifact(index: ArtifactIndex, workOrder: WorkOrder, pick: ArtifactPick): ArtifactFileView | undefined {
  const files = index.files.filter((file) => file.stationId === releaseStationId(workOrder));
  switch (pick) {
    case "readme":
      return shortestPath(files.filter((file) => basename(file.path).toLowerCase() === "readme.md"));
    case "test-report":
      return shortestPath(files.filter((file) => basename(file.path) === "test-report.json"));
    case "patch":
      return shortestPath(files.filter((file) => viewerKind({ path: file.path, viewable: true }) === "diff"));
    case "notes":
      return shortestPath(files.filter((file) => basename(file.path).toLowerCase() === "release.md"));
  }
}

/** The release bundle's README or test report when present, else the first file. */
export function defaultArtifact(index: ArtifactIndex, workOrder: WorkOrder): ArtifactFileView | undefined {
  return (
    pickReleaseArtifact(index, workOrder, "readme") ??
    pickReleaseArtifact(index, workOrder, "test-report") ??
    groupArtifacts(index, workOrder)[0]?.files[0]
  );
}

/** First file of a station, preferring its test report. */
export function stationDefaultArtifact(index: ArtifactIndex, stationId: string): ArtifactFileView | undefined {
  const files = index.files.filter((file) => file.stationId === stationId);
  return files.find((file) => basename(file.path) === "test-report.json") ?? sortByPath(files)[0];
}

// ─── Content ─────────────────────────────────────────────────────────────────────────────────────────────────

const contentCache = new Map<string, string>();
const CACHE_LIMIT = 80;

function cacheSet(key: string, text: string): void {
  contentCache.delete(key);
  contentCache.set(key, text);
  while (contentCache.size > CACHE_LIMIT) {
    const oldest = contentCache.keys().next().value;
    if (oldest === undefined) break;
    contentCache.delete(oldest);
  }
}

export type ContentState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly text: string }
  | { readonly status: "error"; readonly message: string };

/** Fetches (and caches by digest) the text of one artifact version. */
export function useArtifactContent(
  workOrderId: string,
  file: ArtifactFileView | undefined,
  version: ArtifactVersionView | undefined,
): { readonly content: ContentState; readonly retry: () => void } {
  const key =
    file && version && file.viewable
      ? `${workOrderId}\n${file.stationId}\n${file.path}\n${version.version}\n${version.digest}`
      : undefined;
  const [result, setResult] = useState<{ readonly key: string; readonly error?: string; readonly text?: string }>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!key || !file || !version || contentCache.has(key)) return;
    let cancelled = false;
    api.artifactContent(workOrderId, file.stationId, file.path, version.version).then(
      (text) => {
        cacheSet(key, text);
        if (!cancelled) setResult({ key, text });
      },
      (error: unknown) => {
        if (!cancelled) setResult({ key, error: errorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, attempt, workOrderId]); // `file` and `version` are captured through `key`.

  const retry = useCallback(() => {
    setResult(undefined);
    setAttempt((value) => value + 1);
  }, []);

  if (!key) return { content: { status: "idle" }, retry };
  const cached = contentCache.get(key);
  if (cached !== undefined) return { content: { status: "ready", text: cached }, retry };
  if (result?.key === key) {
    if (result.text !== undefined) return { content: { status: "ready", text: result.text }, retry };
    if (result.error !== undefined) return { content: { status: "error", message: result.error }, retry };
  }
  return { content: { status: "loading" }, retry };
}

// ─── Test reports ────────────────────────────────────────────────────────────────────────────────────────────

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseTestReport(text: string): TestReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Partial<TestReport>;
  const summary = candidate.summary;
  if (!summary || !isNumber(summary.total) || !isNumber(summary.passed) || !isNumber(summary.failed)) return undefined;
  if (!Array.isArray(candidate.tests)) return undefined;
  return {
    schema: "factory.test-report/v1",
    mode: candidate.mode === "release" ? "release" : "task",
    taskId: candidate.taskId,
    command: typeof candidate.command === "string" ? candidate.command : "",
    startedAt: typeof candidate.startedAt === "string" ? candidate.startedAt : "",
    durationMs: isNumber(candidate.durationMs) ? candidate.durationMs : 0,
    exitCode: isNumber(candidate.exitCode) ? candidate.exitCode : 0,
    summary: { total: summary.total, passed: summary.passed, failed: summary.failed, skipped: isNumber(summary.skipped) ? summary.skipped : 0 },
    files: Array.isArray(candidate.files) ? candidate.files.filter((file): file is string => typeof file === "string") : [],
    tests: candidate.tests.filter(
      (test): test is TestReport["tests"][number] =>
        typeof test === "object" && test !== null && typeof (test as { name?: unknown }).name === "string",
    ),
    output: typeof candidate.output === "string" ? candidate.output : undefined,
  };
}
