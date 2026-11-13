import { describe, expect, it } from "vitest";

import { guessColumnMapping, readCsvPreview } from "../phase3/csv-preview";
import {
  fileExtension,
  MAX_SOURCE_BYTES,
  validateMapping,
  validateSourceFile,
} from "../phase3/ingest-client";

function csvFile(name: string, content: string): File {
  return new File([content], name, { type: "text/csv" });
}

describe("csv preview", () => {
  it("reads the header and a bounded row window", async () => {
    const preview = await readCsvPreview(
      csvFile(
        "points.csv",
        "lng,lat,max_ma,min_ma\n" +
          Array.from({ length: 40 }, (_unused, index) => `${index},10,5,1`).join("\n") +
          "\n",
      ),
    );
    expect(preview.delimiter).toBe(",");
    expect(preview.headerList).toEqual(["lng", "lat", "max_ma", "min_ma"]);
    expect(preview.rowList.length).toBe(8);
    expect(preview.rowList[0]).toEqual(["0", "10", "5", "1"]);
    expect(preview.truncated).toBe(false);
  });

  it("detects a tab delimiter", async () => {
    const preview = await readCsvPreview(
      csvFile("points.tsv", "lng\tlat\tcount\n1\t2\t3\n"),
    );
    expect(preview.delimiter).toBe("\t");
    expect(preview.headerList).toEqual(["lng", "lat", "count"]);
  });

  it("keeps a quoted delimiter inside its field", async () => {
    const preview = await readCsvPreview(
      csvFile("points.csv", 'lng,lat,label\n1,2,"Ohio, USA"\n'),
    );
    expect(preview.rowList[0]).toEqual(["1", "2", "Ohio, USA"]);
  });

  it("unescapes a doubled quote", async () => {
    const preview = await readCsvPreview(
      csvFile("points.csv", 'lng,lat,label\n1,2,"6"" core"\n'),
    );
    expect(preview.rowList[0]?.[2]).toBe('6" core');
  });

  it("rejects a file without a usable header", async () => {
    await expect(readCsvPreview(csvFile("points.csv", "\n\n"))).rejects.toThrow(
      /no readable rows/,
    );
    await expect(
      readCsvPreview(csvFile("points.csv", "onlyonecolumn\n1\n")),
    ).rejects.toThrow(/at least two columns/);
  });
});

describe("column mapping guesses", () => {
  it("recognizes conventional paleobiology headers", () => {
    const guess = guessColumnMapping([
      "occurrence_no",
      "lng",
      "lat",
      "max_ma",
      "min_ma",
      "plate_id",
    ]);
    expect(guess.longitudeColumn).toBe("lng");
    expect(guess.latitudeColumn).toBe("lat");
    expect(guess.ageStartColumn).toBe("max_ma");
    expect(guess.ageEndColumn).toBe("min_ma");
    expect(guess.plateIdColumn).toBe("plate_id");
  });

  it("matches case and separator variants", () => {
    const guess = guessColumnMapping(["Longitude", "Latitude", "Age Start", "Age End"]);
    expect(guess.longitudeColumn).toBe("Longitude");
    expect(guess.latitudeColumn).toBe("Latitude");
    expect(guess.ageStartColumn).toBe("Age Start");
    expect(guess.ageEndColumn).toBe("Age End");
  });

  it("leaves unknown columns unmapped instead of guessing wrong", () => {
    const guess = guessColumnMapping(["alpha", "beta"]);
    expect(guess.longitudeColumn).toBe("");
    expect(guess.latitudeColumn).toBe("");
    expect(guess.plateIdColumn).toBe("");
  });
});

describe("client-side ingest guards", () => {
  it("accepts a representative source file", () => {
    expect(validateSourceFile(csvFile("points.csv", "lng,lat\n1,2\n"))).toBe("");
    expect(fileExtension("points.CSV")).toBe("csv");
  });

  it("rejects an empty, oversized, or unsupported file before any upload", () => {
    expect(validateSourceFile(csvFile("points.csv", ""))).toMatch(/empty/);
    expect(validateSourceFile(csvFile("points.xlsx", "lng,lat\n1,2\n"))).toMatch(
      /csv, tsv, and txt/,
    );
    const oversized = csvFile("points.csv", "lng,lat\n1,2\n");
    Object.defineProperty(oversized, "size", { value: MAX_SOURCE_BYTES + 1 });
    expect(validateSourceFile(oversized)).toMatch(/limit is 256 MB/);
  });

  it("requires coordinates and a complete age pair", () => {
    const base = {
      ageEndColumn: "",
      ageStartColumn: "",
      latitudeColumn: "lat",
      longitudeColumn: "lng",
      occurrenceColumn: "",
      plateIdColumn: "",
    };
    expect(validateMapping(base)).toBe("");
    expect(validateMapping({ ...base, longitudeColumn: "" })).toMatch(
      /Longitude and latitude/,
    );
    expect(validateMapping({ ...base, ageStartColumn: "max_ma" })).toMatch(
      /both age columns/,
    );
    expect(
      validateMapping({ ...base, ageStartColumn: "max_ma", ageEndColumn: "min_ma" }),
    ).toBe("");
  });
});
