import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parsePlatesRotationFile } from "@timemachine/reconstruction-core";

describe("PLATES rotation parser", () => {
  it("splits crossovers and keeps 999 samples disabled", () => {
    const text = [
      "101 0 0 0 0 714 ! present",
      "101 50 80 10 20 714 ! younger circuit",
      "999 75 70 20 30 714 ! disabled",
      "101 100 60 30 40 714 ! older",
      "101 100 45 40 50 000 ! crossover",
      "101 200 40 50 60 000 ! direct",
    ].join("\n");

    const result = parsePlatesRotationFile(text);
    expect(result.disabledSampleCount).toBe(1);
    expect(result.sequences).toHaveLength(2);
    expect(result.sequences[0]?.fixedPlateId).toBe(714);
    expect(result.sequences[0]?.samples).toHaveLength(3);
    expect(result.sequences[1]?.fixedPlateId).toBe(0);
  });

  it("parses the supplied PALEOMAP rotation file without numeric errors", () => {
    const text = readFileSync(
      resolve("data/PlateModelData/PALEOMAP_PlateModel.rot"),
      "utf8",
    );
    const result = parsePlatesRotationFile(text);
    expect(result.parsedLineCount).toBeGreaterThan(1_400);
    expect(result.sequences.length).toBeGreaterThan(200);
    expect(
      result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    ).toHaveLength(0);
  });
});
