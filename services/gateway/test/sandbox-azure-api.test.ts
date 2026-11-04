import { describe, expect, it, vi } from "vitest";
import { SandboxApi } from "../src/modules/sandbox/providers/azure/api.js";

const endpoint = "https://management.westus2.azuredevcompute.io";
const group = "/subscriptions/sub/resourceGroups/rg/sandboxGroups/group";

function apiFor(bodies: unknown[]) {
  const request = vi.fn<typeof fetch>();
  for (const body of bodies) {
    request.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
  }
  const api = new SandboxApi({
    endpoint, subscriptionId: "sub", resourceGroup: "rg", sandboxGroup: "group",
    apiVersion: "2026-02-01-preview", tokens: { token: async () => "test-token" }, fetch: request,
  });
  return { api, request };
}

describe("Azure data-plane listing validation", () => {
  it("reads both qualified bare arrays and paged envelopes", async () => {
    const bare = apiFor([[{ id: "one" }]]);
    expect(await bare.api.listSandboxes()).toEqual([{ id: "one" }]);
    const paged = apiFor([
      { value: [{ id: "one" }], nextLink: `${group}/sandboxes?cursor=2` },
      { value: [{ id: "two" }] },
    ]);
    expect((await paged.api.listSandboxes()).map((sandbox) => sandbox.id)).toEqual(["one", "two"]);
    expect(paged.request).toHaveBeenCalledTimes(2);
  });

  it.each(["https://elsewhere.example/sandboxes", `${endpoint}/subscriptions/other/sandboxes`, 42])(
    "refuses an invalid or out-of-scope continuation rather than returning a partial listing: %s",
    async (nextLink) => {
      const { api, request } = apiFor([{ value: [{ id: "one" }], nextLink }]);
      await expect(api.listSandboxes()).rejects.toMatchObject({ code: "invalid_response" });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses a pagination cycle", async () => {
    const { api, request } = apiFor([{ value: [], nextLink: `${endpoint}${group}/sandboxes?api-version=2026-02-01-preview` }]);
    await expect(api.listSandboxes()).rejects.toMatchObject({ code: "invalid_response" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("validates image and volume entries instead of silently skipping unknown resources", async () => {
    await expect(apiFor([{ value: [{}] }]).api.listDiskImages()).rejects.toMatchObject({ code: "invalid_response" });
    await expect(apiFor([{ value: [{ type: "DataDisk", volumeName: "disk" }] }]).api.listVolumes()).rejects.toMatchObject({ code: "invalid_response" });
    expect(await apiFor([[{ type: "DataDisk", volumeName: "disk", isAttached: false }]]).api.listVolumes())
      .toEqual([{ type: "DataDisk", volumeName: "disk", name: "disk", isAttached: false }]);
  });

  it("requires valid successful GET and execution responses", async () => {
    await expect(apiFor([null]).api.getSandbox("one")).rejects.toMatchObject({ code: "invalid_response" });
    await expect(apiFor([{}]).api.getDiskImage("one")).rejects.toMatchObject({ code: "invalid_response" });
    await expect(apiFor([{}]).api.executeShellCommand("one", "true")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("does not mistake missing ownership labels or a different resource identity for a valid lookup", async () => {
    await expect(apiFor([[{ id: "one" }]]).api.listSandboxes({ "mc-instance": "mine" })).rejects.toMatchObject({ code: "invalid_response" });
    await expect(apiFor([{ id: "other" }]).api.getSandbox("one")).rejects.toMatchObject({ code: "invalid_response" });
    await expect(apiFor([{ id: "other" }]).api.getDiskImage("one")).rejects.toMatchObject({ code: "invalid_response" });
    await expect(apiFor([{ type: "DataDisk", name: "other", isAttached: false }]).api.getVolume("one")).rejects.toMatchObject({ code: "invalid_response" });
  });
});
