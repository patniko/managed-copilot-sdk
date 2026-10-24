import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactIndex, FactoryState, ServerEvent, StationStatus, WorkOrder } from "../../src/shared/types.js";

const api = vi.hoisted(() => ({
  state: vi.fn(),
  workOrder: vi.fn(),
  activity: vi.fn(),
  artifacts: vi.fn(),
}));

vi.mock("../../src/web/lib/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/web/lib/api.js")>()),
  api,
}));

class FakeEventSource {
  static current: FakeEventSource | undefined;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  readonly #listeners = new Map<string, (message: { data: string }) => void>();

  constructor(readonly url: string) {
    FakeEventSource.current = this;
  }

  addEventListener(type: string, listener: (message: { data: string }) => void): void {
    this.#listeners.set(type, listener);
  }

  close(): void {
    this.readyState = 2;
  }

  emit(event: ServerEvent): void {
    this.#listeners.get(event.type)?.({ data: JSON.stringify(event) });
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const STATE = {
  platform: { state: "connected", checkedAt: "2026-01-01T00:00:00.000Z", environments: [], features: { attach: false } },
  templates: [],
  workOrders: [],
  attachCommand: "",
  canLaunchTerminal: false,
} as unknown as FactoryState;

function workOrder(updatedAt: string, buildStatus: StationStatus = "working"): WorkOrder {
  return {
    id: "wo_1",
    number: 1,
    title: "CSV toolkit",
    status: "building",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    taskCount: 1,
    stations: [
      { id: "plan", kind: "plan", title: "Plan", status: "done", round: 1 },
      { id: "build:a", kind: "build", title: "Build · A", taskId: "a", status: buildStatus, round: 1 },
    ],
  } as unknown as WorkOrder;
}

function index(...paths: string[]): ArtifactIndex {
  return {
    workOrderId: "wo_1",
    files: paths.map((path) => ({ stationId: "release", path, contentType: "text/markdown", viewable: true, versions: [] })),
  };
}

async function loadStore() {
  vi.resetModules();
  vi.stubGlobal("EventSource", FakeEventSource);
  api.state.mockResolvedValue(STATE);
  const store = await import("../../src/web/lib/store.js");
  const { ApiError } = await import("../../src/web/lib/api.js");
  store.startFactory();
  await flush();
  return { store, ApiError, events: FakeEventSource.current! };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("web store", () => {
  it("keeps an artifact invalidation that arrives while the index is loading", async () => {
    const { store, events } = await loadStore();
    const first = deferred<ArtifactIndex>();
    api.artifacts.mockReturnValueOnce(first.promise).mockResolvedValueOnce(index("README.md"));

    store.ensureArtifacts("wo_1");
    events.emit({ type: "artifacts", workOrderId: "wo_1" });
    first.resolve(index());
    await flush();
    expect(store.getState().artifacts.wo_1).toMatchObject({ loading: false, stale: true });

    // What `useArtifactIndex` does when `loading` drops.
    store.ensureArtifacts("wo_1");
    await flush();
    expect(api.artifacts).toHaveBeenCalledTimes(2);
    expect(store.getState().artifacts.wo_1?.data?.files.map((file) => file.path)).toEqual(["README.md"]);
    expect(store.getState().artifacts.wo_1?.stale).toBe(false);
  });

  it("doesn't refetch when nothing changed during the request", async () => {
    const { store } = await loadStore();
    api.artifacts.mockResolvedValueOnce(index("README.md"));
    store.ensureArtifacts("wo_1");
    await flush();
    store.ensureArtifacts("wo_1");
    await flush();
    expect(api.artifacts).toHaveBeenCalledTimes(1);
  });

  it("treats a 404 for a work order it had shown as a deletion", async () => {
    const { store, ApiError } = await loadStore();
    api.workOrder
      .mockResolvedValueOnce(workOrder("2026-01-01T00:01:00.000Z"))
      .mockRejectedValueOnce(new ApiError("That work order doesn't exist.", "not_found", 404));
    store.ensureWorkOrder("wo_1");
    await flush();
    expect(store.getState().workOrders.wo_1?.data?.id).toBe("wo_1");
    expect(store.getState().summaries.map((summary) => summary.id)).toEqual(["wo_1"]);

    store.ensureWorkOrder("wo_1", true);
    await flush();
    const entry = store.getState().workOrders.wo_1;
    expect(entry?.data).toBeUndefined();
    expect(entry?.error?.code).toBe("deleted");
    expect(store.getState().summaries).toEqual([]);
  });

  it("keeps a 404 for a work order it never had as a plain error", async () => {
    const { store, ApiError } = await loadStore();
    api.workOrder.mockRejectedValueOnce(new ApiError("That work order doesn't exist.", "not_found", 404));
    store.ensureWorkOrder("wo_x");
    await flush();
    expect(store.getState().workOrders.wo_x?.error?.code).toBe("not_found");
  });

  it("drops streaming drafts once a station stops working, and ignores late deltas", async () => {
    const { store, events } = await loadStore();
    const key = store.activityKey("wo_1", "build:a");
    events.emit({ type: "workOrder", workOrder: workOrder("2026-01-01T00:01:00.000Z", "working") });
    events.emit({ type: "delta", workOrderId: "wo_1", stationId: "build:a", messageId: "m1", text: "Running " });
    expect(store.getState().drafts[key]).toEqual([{ messageId: "m1", text: "Running " }]);

    events.emit({ type: "workOrder", workOrder: workOrder("2026-01-01T00:02:00.000Z", "collecting") });
    expect(store.getState().drafts[key]).toBeUndefined();

    events.emit({ type: "delta", workOrderId: "wo_1", stationId: "build:a", messageId: "m1", text: "the tests" });
    expect(store.getState().drafts[key]).toBeUndefined();
  });
});
