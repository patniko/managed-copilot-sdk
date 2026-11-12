import { describe, expect, it } from "vitest";
import { DOWNHILL_PORT, downhill } from "../apphost.mts";

describe("AppHost fragment", () => {
  it("describes the app the way the root AppHost expects, with no environments of its own", () => {
    const fragment = downhill();
    expect(fragment).toEqual({ app: { name: "downhill", workingDirectory: expect.stringMatching(/downhill$/), script: "dist/server/main.js", port: DOWNHILL_PORT, healthPath: "/api/health" } });
    expect(downhill({ port: 9255 }).app.port).toBe(9255);
  });
});
