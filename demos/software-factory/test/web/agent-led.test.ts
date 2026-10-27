import { describe, expect, it } from "vitest";
import { workOrderMode } from "../../src/shared/types.js";
import { createFixtures, withPreviewCoordinator } from "../../src/web/dev/fixtures.js";
import { runsBlockedReason } from "../../src/web/lib/platform.js";
import { pipelineStations } from "../../src/web/lib/stations.js";

describe("agent-led floor data", () => {
  it("keeps old records Classic and preserves the explicit mode", () => {
    expect(workOrderMode({})).toBe("classic");
    expect(workOrderMode({ mode: "agent" })).toBe("agent");
  });

  it("the labeled preview includes coordinator decisions and reused workers", () => {
    const fixtures = createFixtures(Date.now(), "");
    const order = fixtures.workOrders.find((item) => item.id === "wo_csvjson")!;
    expect(order.mode).toBe("agent");
    expect(pipelineStations(order).slice(0, 2).map((item) => item.kind)).toEqual(["plan", "coordinate"]);
    expect(order.stations.some((item) => item.worker && item.round > item.worker.createdRound)).toBe(true);
    expect(fixtures.activity.get(order.id)?.some((item) => item.decision?.tag === "reused")).toBe(true);
    expect(withPreviewCoordinator(order).stations.filter((item) => item.kind === "coordinate")).toHaveLength(1);
    const classic = fixtures.workOrders.find((item) => item.id !== order.id)!;
    expect(withPreviewCoordinator(classic)).toBe(classic);
  });

  it("blocks unsupported agent-led runs without silently choosing Classic", () => {
    const { platform } = createFixtures(Date.now(), "empty");
    const unsupported = { ...platform, features: { ...platform.features, agentLed: false } };
    expect(runsBlockedReason(unsupported, "classic")).toBeUndefined();
    expect(runsBlockedReason(unsupported, "agent")).toContain("factory-coordinator");
  });
});
