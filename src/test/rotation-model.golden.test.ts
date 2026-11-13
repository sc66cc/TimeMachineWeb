import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parsePlatesRotationFile,
  rotateLonLat,
  RotationModel,
} from "@timemachine/reconstruction-core";

const PRESENT_POINT = {
  latitude: 24.79794927575685,
  longitude: -77.67147984814453,
};

// Generated independently with pyGPlates 1.0.0:
// RotationModel(rot).get_rotation(time, 101, 0) * PointOnSphere(...)
const GOLDEN_COORDINATES = [
  [25, -72.79361708889918, 24.839916291633276],
  [50, -65.3112723309134, 25.371111096170694],
  [100, -44.63839102755981, 18.256936482251216],
  [200, -21.52519690547444, 5.117385211092726],
  [500, -101.37810573404865, -35.49694765858385],
] as const;

const MULTI_CIRCUIT_GOLDENS = [
  [102, 50, 31.471304250373485, -25.022372030808526],
  [102, 250, 91.90090468563136, -26.073767787322573],
  [102, 500, 86.25106533323499, -45.77414140037722],
  [104, 50, 31.987765536156854, -24.707507029589088],
  [104, 250, 99.83089053230287, -33.147496397571985],
  [104, 500, 97.47381745434842, -40.26132526616066],
  [201, 50, 34.39898368375947, -17.692253106508208],
  [201, 250, 67.05262479267071, -27.454305989912278],
  [201, 500, 148.57162152334053, -5.997243311199926],
  [301, 50, 21.172523425410734, -20.857048607228638],
  [301, 250, 63.14880840041846, -40.30764226704046],
  [301, 500, -122.93369864510417, -33.784340752224004],
  [501, 50, 1.7455984532803586, -13.146146293692535],
  [501, 250, -7.430810971702926, -3.4605709720583353],
  [501, 500, 127.83121909680656, -79.97537380711218],
  [701, 50, 14.433918239238732, -25.689780645826247],
  [701, 250, -2.8843192220586493, -53.270911466889835],
  [701, 500, -159.7157442249262, -37.679057430642274],
  [901, 50, 49.591105402160906, -8.008347050753803],
  [901, 250, 52.484136286050315, 17.38827365338647],
  [901, 500, 102.00855804652507, -18.397198520354262],
  [714, 50, 14.433918239238732, -25.689780645826247],
  [714, 250, 3.317206396795453, -54.631719412621116],
  [714, 500, -163.28295195192376, -35.0502248182573],
] as const;

describe("rotation model against pyGPlates golden values", () => {
  const rotationText = readFileSync(
    resolve("data/PlateModelData/PALEOMAP_PlateModel.rot"),
    "utf8",
  );
  const parsed = parsePlatesRotationFile(rotationText);
  const model = new RotationModel(parsed.sequences);

  for (const [timeMa, expectedLongitude, expectedLatitude] of GOLDEN_COORDINATES) {
    it(`reconstructs plate 101 at ${timeMa} Ma`, () => {
      const rotation = model.getRotation(timeMa, 101, 0);
      expect(rotation).toBeDefined();
      const [longitude, latitude] = rotateLonLat(
        rotation!,
        PRESENT_POINT.longitude,
        PRESENT_POINT.latitude,
      );
      expect(longitude).toBeCloseTo(expectedLongitude, 9);
      expect(latitude).toBeCloseTo(expectedLatitude, 9);
    });
  }

  for (const [
    plateId,
    timeMa,
    expectedLongitude,
    expectedLatitude,
  ] of MULTI_CIRCUIT_GOLDENS) {
    it(`matches pyGPlates for plate ${plateId} at ${timeMa} Ma`, () => {
      const rotation = model.getRotation(timeMa, plateId, 0);
      expect(rotation).toBeDefined();
      const [longitude, latitude] = rotateLonLat(rotation!, 23, -17);
      expect(longitude).toBeCloseTo(expectedLongitude, 8);
      expect(latitude).toBeCloseTo(expectedLatitude, 8);
    });
  }
});
