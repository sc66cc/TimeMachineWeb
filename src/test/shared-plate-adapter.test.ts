import { describe, expect, it } from "vitest";

import {
  GeoPolygonTO,
  GeoSpherePointTO,
  PlateGeoTO,
  PlateModelTO,
  PlateRotationTO,
} from "@timemachine/generated-api";

import {
  convertPlateGeoList,
  convertPlateModelContent,
  convertPlateRotationList,
} from "../plate-model/plate-model-adapter";

function spherePoint(longitude: number, latitude: number): GeoSpherePointTO {
  const point = new GeoSpherePointTO();
  point.Longitude = longitude;
  point.Latitude = latitude;
  return point;
}

function triangle(): GeoPolygonTO {
  const polygon = new GeoPolygonTO();
  polygon.PosList.push(spherePoint(0, 0));
  polygon.PosList.push(spherePoint(10, 0));
  polygon.PosList.push(spherePoint(0, 10));
  return polygon;
}

function geo(overrides: Partial<PlateGeoTO> = {}): PlateGeoTO {
  const value = new PlateGeoTO();
  value.FeatureName = "triangle";
  value.PlateID = 101;
  value.FeatureID = "fixture-feature";
  value.ValidTime.Begin = 100;
  value.ValidTime.End = 0;
  value.Polygon.push(triangle());
  return Object.assign(value, overrides);
}

function rotation(overrides: Partial<PlateRotationTO> = {}): PlateRotationTO {
  return Object.assign(new PlateRotationTO(), overrides);
}

describe("convertPlateGeoList", () => {
  it("keeps PosList longitude/latitude in degrees and leaves holes empty", () => {
    const result = convertPlateGeoList([geo()]);

    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.polygons).toEqual([
      {
        exterior: [
          [0, 0],
          [10, 0],
          [0, 10],
        ],
        holes: [],
      },
    ]);
    expect(result.polygonCount).toBe(1);
    expect(result.unsupportedGeometryCount).toBe(0);
  });

  it("keeps identity, plate id and valid time verbatim", () => {
    const result = convertPlateGeoList([geo()]);
    const [feature] = result.features;

    expect(feature?.id).toBe("fixture-feature");
    expect(feature?.plateId).toBe(101);
    expect(feature?.name).toBe("triangle");
    expect(feature?.validFromMa).toBe(100);
    expect(feature?.validToMa).toBe(0);
    expect(feature?.sourceIndex).toBe(0);
  });

  it("keeps a 0..0 valid time as a 0 Ma-only range", () => {
    const result = convertPlateGeoList([geo({ ValidTime: { Begin: 0, End: 0 } })]);
    expect(result.features[0]?.validFromMa).toBe(0);
    expect(result.features[0]?.validToMa).toBe(0);
  });

  it("keeps 9999 as an ordinary value", () => {
    const result = convertPlateGeoList([
      geo({ ValidTime: { Begin: 9999, End: 9999 } }),
    ]);
    expect(result.features[0]?.validFromMa).toBe(9999);
    expect(result.features[0]?.validToMa).toBe(9999);
  });

  it("records features without polygon geometry", () => {
    const result = convertPlateGeoList([geo(), geo({ Polygon: [] })]);
    expect(result.polygonCount).toBe(1);
    expect(result.unsupportedGeometryCount).toBe(1);
    expect(result.warnings).toEqual([
      "fixture-feature: no polygon geometry; the feature cannot be drawn.",
    ]);
  });

  it("falls back to a synthetic identity when the feature has no IDs", () => {
    const result = convertPlateGeoList([
      geo({ FeatureID: "", FeatureName: "" }),
    ]);
    expect(result.features[0]?.id).toBe("feature-0");
    expect(result.features[0]?.name).toBe("Plate 101");
  });
});

describe("convertPlateRotationList", () => {
  it("keeps the list order and the PLATES field order", () => {
    const result = convertPlateRotationList([
      rotation({ ID: 101, ParentID: 0, Age: 0 }),
      rotation({ ID: 101, ParentID: 0, Age: 100, PoleLatitude: 90, PoleAngle: 10 }),
    ]);

    expect(result.parsedLineCount).toBe(2);
    expect(result.sequences).toHaveLength(1);
    expect(result.sequences[0]?.movingPlateId).toBe(101);
    expect(result.sequences[0]?.fixedPlateId).toBe(0);
    expect(result.sequences[0]?.samples.map((sample) => sample.timeMa)).toEqual([
      0, 100,
    ]);
    expect(result.sequences[0]?.samples[1]?.poleLatitudeDeg).toBe(90);
    expect(result.sequences[0]?.samples[1]?.angleDeg).toBe(10);
  });

  it("reuses the 999 disabled-sample rule", () => {
    const result = convertPlateRotationList([
      rotation({ ID: 101, ParentID: 0, Age: 0 }),
      rotation({ ID: 999, ParentID: 0, Age: 75, Comment: "disabled" }),
      rotation({ ID: 101, ParentID: 0, Age: 100 }),
    ]);

    expect(result.disabledSampleCount).toBe(1);
    expect(result.sequences[0]?.samples).toHaveLength(2);
    expect(result.sequences[0]?.samples.every((sample) => sample.enabled)).toBe(
      true,
    );
  });

  it("reuses the crossover segmentation rule", () => {
    const result = convertPlateRotationList([
      rotation({ ID: 101, ParentID: 0, Age: 0 }),
      rotation({ ID: 101, ParentID: 0, Age: 100 }),
      rotation({ ID: 101, ParentID: 714, Age: 0 }),
      rotation({ ID: 101, ParentID: 714, Age: 100 }),
    ]);

    expect(result.sequences).toHaveLength(2);
    expect(result.sequences[0]?.fixedPlateId).toBe(0);
    expect(result.sequences[1]?.fixedPlateId).toBe(714);
  });

  it("keeps a negative Age as a future time instead of flipping the sign", () => {
    const result = convertPlateRotationList([
      rotation({ ID: 101, ParentID: 0, Age: -5 }),
      rotation({ ID: 101, ParentID: 0, Age: 0 }),
      rotation({ ID: 101, ParentID: 0, Age: 50 }),
    ]);

    expect(result.sequences[0]?.samples.map((sample) => sample.timeMa)).toEqual([
      -5, 0, 50,
    ]);
    expect(result.sequences[0]?.youngestTimeMa).toBe(-5);
  });

  it("keeps comments that would otherwise break the line format", () => {
    const result = convertPlateRotationList([
      rotation({ ID: 101, ParentID: 0, Age: 0, Comment: "a\nb" }),
      rotation({ ID: 101, ParentID: 0, Age: 100 }),
    ]);

    expect(result.parsedLineCount).toBe(2);
    expect(result.sequences[0]?.samples[0]?.comment).toBe("a b");
  });
});

describe("convertPlateModelContent", () => {
  it("returns both parse results for a shared model", () => {
    const content = new PlateModelTO();
    content.GeoList.push(geo());
    content.RotationList.push(rotation({ ID: 101, ParentID: 0, Age: 0 }));
    content.RotationList.push(
      rotation({ ID: 101, ParentID: 0, Age: 100, PoleLatitude: 90 }),
    );

    const runtime = convertPlateModelContent(content);

    expect(runtime.gpmlParseResult.features).toHaveLength(1);
    expect(runtime.gpmlParseResult.polygonCount).toBe(1);
    expect(runtime.rotationParseResult.sequences).toHaveLength(1);
    expect(runtime.rotationParseResult.sequences[0]?.samples).toHaveLength(2);
  });

  it("handles an empty model without throwing", () => {
    const runtime = convertPlateModelContent(new PlateModelTO());
    expect(runtime.gpmlParseResult.features).toEqual([]);
    expect(runtime.rotationParseResult.sequences).toEqual([]);
  });
});
