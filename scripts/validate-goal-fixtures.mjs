import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../data/goal-fixtures");
const readJson = (name) => JSON.parse(readFileSync(resolve(fixtureRoot, name), "utf8"));

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

// A small fixture validator, not a replacement for a GeoJSON/topology library.
export function validateGeometry(geometry) {
  const point = (value) => requireCondition(
    Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) &&
    Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90,
    "COORDINATE",
  );
  const line = (values) => {
    requireCondition(Array.isArray(values) && values.length >= 2, "EMPTY");
    values.forEach(point);
    requireCondition(values.some(([x, y]) => x !== values[0][0] || y !== values[0][1]), "DEGENERATE");
  };
  const ring = (values) => {
    line(values);
    requireCondition(values.length >= 4 && values[0][0] === values.at(-1)[0] && values[0][1] === values.at(-1)[1], "RING_CLOSED");
    // Unwrap before signed area so the 170/-170 specimen is interpreted at its short seam.
    const unwrapped = [values[0]];
    for (const [x, y] of values.slice(1)) {
      const previousX = unwrapped.at(-1)[0];
      unwrapped.push([x + 360 * Math.round((previousX - x) / 360), y]);
    }
    const twiceArea = unwrapped.slice(1).reduce((sum, [x, y], i) => sum + unwrapped[i][0] * y - x * unwrapped[i][1], 0);
    requireCondition(Math.abs(twiceArea) > 1e-9, "DEGENERATE");
  };
  const polygon = (rings) => {
    requireCondition(Array.isArray(rings) && rings.length > 0, "EMPTY");
    rings.forEach(ring);
    // This bundle's only hole is rectangular, non-seam-crossing and strictly internal.
    if (rings.length > 1) {
      const xs = rings[0].map(([x]) => x), ys = rings[0].map(([, y]) => y);
      for (const hole of rings.slice(1)) for (const [x, y] of hole) {
        requireCondition(x > Math.min(...xs) && x < Math.max(...xs) && y > Math.min(...ys) && y < Math.max(...ys), "HOLE_OUTSIDE");
      }
    }
  };
  const each = (values, fn) => {
    requireCondition(Array.isArray(values) && values.length > 0, "EMPTY");
    values.forEach(fn);
  };
  switch (geometry.type) {
    case "Point": point(geometry.coordinates); break;
    case "MultiPoint": each(geometry.coordinates, point); break;
    case "LineString": line(geometry.coordinates); break;
    case "MultiLineString": each(geometry.coordinates, line); break;
    case "Polygon": polygon(geometry.coordinates); break;
    case "MultiPolygon": each(geometry.coordinates, polygon); break;
    default: throw new Error("UNSUPPORTED_GEOMETRY");
  }
}

export function validateFixtureBundle() {
  const manifest = readJson("manifest.json");
  assert.equal(manifest.liveServiceEvidence, false);
  assert.deepEqual(manifest.files.map((entry) => entry.path).sort(), readdirSync(fixtureRoot).filter((name) => name !== "manifest.json").sort());
  for (const entry of manifest.files) {
    const bytes = readFileSync(resolve(fixtureRoot, entry.path));
    assert.equal(bytes.length, entry.bytes, entry.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, entry.path);
    assert.equal(entry.source, "synthetic");
  }
  const vectors = readJson("vectors.geojson");
  assert.equal(vectors.type, "FeatureCollection");
  const ids = new Set();
  for (const feature of vectors.features) {
    assert.equal(feature.type, "Feature");
    assert.equal(feature.id, feature.properties.featureId);
    assert.ok(!ids.has(feature.id)); ids.add(feature.id);
    assert.ok([101, 102].includes(feature.properties.plateId));
    const time = feature.properties.validTimeMa;
    assert.ok(time.youngest <= time.oldest && time.youngest >= 0);
    assert.equal(time.endpoints, "inclusive");
    validateGeometry(feature.geometry);
  }
  // Keep the original 12 features frozen; shifted-central-meridian cases are separate.
  const shifted = readJson("shifted-seam-vectors.geojson");
  const seamOracle = readJson("shifted-seam-oracle.json");
  assert.equal(shifted.type, "FeatureCollection");
  assert.equal(shifted.features.length, 2);
  assert.equal(seamOracle.centralMeridianDeg, 30);
  assert.equal(seamOracle.seamLongitudeDeg, -150);
  const relativeLongitude = (longitude) => ((longitude - 30 + 180) % 360 + 360) % 360 - 180;
  for (const feature of shifted.features) {
    assert.equal(feature.type, "Feature");
    assert.equal(feature.id, feature.properties.featureId);
    assert.ok(!ids.has(feature.id));
    assert.equal(feature.properties.plateId, 101);
    assert.deepEqual(feature.properties.validTimeMa, { youngest: 0, oldest: 100, endpoints: "inclusive" });
    validateGeometry(feature.geometry);
    const positions = feature.geometry.type === "Polygon" ? feature.geometry.coordinates[0] : feature.geometry.coordinates;
    const expected = seamOracle.cases.find((entry) => entry.featureId === feature.id);
    assert.ok(expected, feature.id);
    const relative = positions.map(([longitude]) => relativeLongitude(longitude));
    assert.deepEqual(relative, expected.expectedRelativeLongitudesDeg);
    assert.ok(relative.slice(1).some((longitude, index) => Math.abs(longitude - relative[index]) > 180));
  }
  seamOracle.control.geographicLongitudesDeg.forEach((longitude, index) => {
    assert.ok(Math.abs(relativeLongitude(longitude) - seamOracle.control.expectedRelativeLongitudesDeg[index]) < 1e-9);
  });
  assert.ok(Math.abs(seamOracle.control.expectedRelativeLongitudesDeg[0] - seamOracle.control.expectedRelativeLongitudesDeg[1]) < 1);
  const invalid = readJson("invalid-geometries.json");
  for (const entry of invalid.cases) {
    assert.throws(() => validateGeometry(entry.feature.geometry), new RegExp(entry.expectedCode), entry.id);
  }
  for (const age of [0, 100, 200]) {
    const grid = readJson(`numeric-${age}.json`);
    assert.equal(grid.width, 8); assert.equal(grid.height, 8);
    assert.deepEqual(grid.bbox, [-40, -40, 40, 40]);
    assert.deepEqual(grid.pixelCenterOrigin, [-35, 35]);
    assert.deepEqual(grid.pixelStep, [10, -10]);
    assert.equal(grid.rowOrder, "north-to-south");
    assert.equal(grid.units, "synthetic-unit");
    assert.equal(grid.nodata, null);
    assert.equal(grid.values.length, 8); assert.equal(grid.validMask.length, 8);
    grid.values.forEach((row, r) => {
      assert.equal(row.length, 8); assert.equal(grid.validMask[r].length, 8);
      row.forEach((value, c) => {
        const valid = !((r === 0 && c === 0) || (r === 7 && c === 7));
        assert.equal(grid.validMask[r][c], valid);
        assert.equal(value, valid ? (8 * r + c - 28) / 4 + age / 100 : null);
      });
    });
  }
  for (const sample of readJson("sampling-oracle.json").cases) {
    const grid = readJson(sample.file);
    assert.equal(Math.floor((sample.lon + 40) / 10), sample.column);
    assert.equal(Math.floor((40 - sample.lat) / 10), sample.row);
    assert.equal(grid.values[sample.row][sample.column], sample.expected);
  }
  const atlas = readJson("atlas-fixture.json");
  assert.deepEqual(atlas.frames.map((frame) => frame.timeMa), [0, 100, 200]);
  for (const frame of atlas.frames) {
    const bytes = readFileSync(resolve(fixtureRoot, frame.displayFile));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), frame.displaySha256);
    assert.equal(bytes.length, frame.displayBytes);
    assert.equal(readJson(frame.rawValueFile).timeMa, frame.timeMa);
  }
  assert.equal(readJson("rgba-only.json").rawValueFile, null);
  assert.equal(readJson("future-multi-instance-layout.json").loadableProject, false);
  return { files: manifest.files.length, totalBytes: manifest.files.reduce((sum, entry) => sum + entry.bytes, 0), features: ids.size, shiftedSeamFeatures: shifted.features.length, rejectedGeometries: invalid.cases.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--negative-case") {
      const entry = readJson("invalid-geometries.json").cases.find((item) => item.id === process.argv[3]);
      assert.ok(entry, "Unknown negative case");
      validateGeometry(entry.feature.geometry);
      throw new Error("Negative fixture was unexpectedly accepted");
    }
    console.log(JSON.stringify({ status: "PASS", ...validateFixtureBundle(), liveServiceEvidence: false }));
  } catch (error) {
    console.error(`Fixture validation rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
