import { describe, expect, it } from "vitest";
import type { ArtifactFileView, ArtifactIndex } from "../../src/shared/types.js";
import { fileChanges, projectOriginal } from "../../src/web/lib/artifacts.js";

function file(stationId: string, path: string, viewable = true): ArtifactFileView {
  return { stationId, path, contentType: "text/javascript", viewable, versions: [] };
}

const original = file("intake", "project/src/promotions.js");
const index = { files: [original, file("intake", "project/logo.png", false)] } as unknown as ArtifactIndex;

describe("changes against the project's original", () => {
  it("finds the original of a builder's and the release's files", () => {
    expect(projectOriginal(index, file("build:promo", "files/src/promotions.js"))).toBe(original);
    expect(projectOriginal(index, file("release", "bundle/src/promotions.js"))).toBe(original);
  });

  it("has no original for new files, other stations, or files it can't show", () => {
    expect(projectOriginal(index, file("build:promo", "files/src/new.js"))).toBeUndefined();
    expect(projectOriginal(index, file("review", "files/src/promotions.js"))).toBeUndefined();
    expect(projectOriginal(index, file("build:promo", "test-report.json"))).toBeUndefined();
    expect(projectOriginal(index, file("release", "bundle/logo.png"))).toBeUndefined();
  });

  it("diffs a changed file and reports none for an unchanged one", () => {
    const changes = fileChanges("src/a.js", "const a = 1;\n", "const a = 2;\n");
    expect(changes).toContain("--- a/src/a.js");
    expect(changes).toContain("-const a = 1;");
    expect(changes).toContain("+const a = 2;");
    expect(fileChanges("src/a.js", "same\n", "same\n")).toBe("");
  });
});
