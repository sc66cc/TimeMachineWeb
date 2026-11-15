# P0 small synthetic fixtures

These files are synthetic, safe to redistribute with the project, and contain no real service data. They provide deterministic structural/arithmetic checks; they do **not** establish scientific validity, browser rendering acceptance, a working production source, or FIX-14 live integration.

## Coordinates and vectors

`vectors.geojson` is a standard GeoJSON FeatureCollection. Positions are `[longitudeDeg, latitudeDeg]`, not Unity Cartesian coordinates. The reconstruction sphere is centered at `[0,0,0]` with radius **6,371,000 m**. `(0°,0°)` is the equator/Greenwich intersection, not the sphere center. Longitudes use `[-180,180]`, latitude `[-90,90]`; neither coordinate is projected meters. Stable `id` and `properties.featureId` agree; `plateId` is 101 or 102, available in both tiny rotation models.

`validTimeMa` is a thin fixture business property, with **inclusive** youngest/oldest bounds. It is not an established application schema or Cesium field. Most features are visible in `[0,100] Ma`; `origin-other-id` uses `[25,75] Ma`. Ages increase toward the past. Shared coordinates do not imply shared IDs. MultiPoint has one feature ID for the collection; future per-point picking must explicitly choose a subfeature ID strategy.

Ordinary, central-meridian, near-pole and antimeridian lines are included. `seam-line` and `seam-polygon` deliberately preserve short antimeridian-crossing source geometry. A flat projection adapter must split at its display seam; do not mutate the source or draw a 340° chord. `split-seam-multipolygon` provides a pre-cut ±180° comparison. `polygon-hole` has a counterclockwise exterior and clockwise interior; `reversed-winding-polygon` tests tolerant input normalization. The polar polygon is near a pole, not an enclosure of the pole itself. `invalid-geometries.json` contains explicit rejected cases; repeated intermediate vertices, self-intersections and true polar caps remain separate future cases.

`shifted-seam-vectors.geojson` adds **two separate features**, leaving the original 12 unchanged: a line and polygon from longitude -160° to -140°. For central meridian 30°, the display seam is -150° (equivalent to210°); their relative longitudes are170° and-170°. `shifted-seam-oracle.json` records these independent values and a control: geographic±179.9° maps to150.1°/149.9°, which does not cross this shifted seam. Validation checks geometry and subtraction/wrap arithmetic only; it does not prove clipping, rendered topology or picking. The line's seam intersection latitude depends on the selected arc/segment convention, so no guessed midpoint is frozen as truth.

## Raw numeric grid and colors

`numeric-{0,100,200}.json` are local fixture data, **not** GeoTIFF or the existing service sampling format. Each is an 8×8 pixel-area grid with outer bounds `[-40,-40,40,40]` in EPSG:4326. Row 0 is north, column 0 west; center `(r,c)` is `(-35+10c, 35-10r)`. `values[r][c]=(8r+c-28)/4+timeMa/100`, except `(0,0)` and `(7,7)` are **null** and `validMask=false`. Zero is valid data: at time 0, row 3/column 4 is exactly 0. Units are intentionally `synthetic-unit`, with no physical/geological interpretation.

`sampling-oracle.json` lists hand-calculated pixel centers/values and the proposed fixture-only edge tie rule. No application sampler is exercised by these arithmetic checks. A future adapter must declare how it maps its own sampling/NoData contract to this fixture; it must not accidentally promote this JSON format into a production API.

`rgba-only.json` intentionally has no raw data reference. Its SVG may render colors, but a value query must return unavailable. A colorbar does not supply recoverable original values.

## Rotations and independent expectations

Both `.rot` files contain two plates relative to fixed plate 0 at ages 0 and 100 Ma. Model A is identity. Model B rotates about the geographic north pole, reaching 90° for plate 101 and 30° for plate 102 at 100 Ma. Positive right-handed rotation increases longitude. Angles at intermediate times are linear because all rotations share one fixed axis and are below 180°. Relative rotation subtracts the anchor's angle. `rotation-oracle.json` stores explicit independently hand-derived answers, including interpolation, seam normalization, model difference, inverse anchor and anchor 102; no production algorithm generated them.

The current RotationModel defaults to extending its oldest rotation into the distant past. Tests of the finite `[0,100]` model use `{extendToDistantPast:false}` explicitly; do not assume the default already enforces the fixture interval.

`model-noncoaxial.rot` and `rotation-noncoaxial-oracle.json` add the noncommuting anchor check that the original common-axis examples cannot provide. At100Ma, moving plate101 rotates +90° about geographic north (+Z), and anchor102 rotates +90° about the Greenwich equator axis (+X). With `s=1/sqrt(2)`, source `(0°,45°)` is `(s,0,s)`. Correct `Rx(-90) * Rz(+90)` gives `(0,s,-s)`, hence `(90°,-45°)`. Reversed order gives `(-s,s,0)`, hence `(135°,0°)`. Both outputs are hand-derived; production code never generates expected data.

The project basis is explicitly X=(lon0,lat0), Y=(lon90,lat0), Z=north, right-handed. It matches the oracle and Cesium world basis, so the basis transform is identity. Do not import Unity's left-handed/Y-up coordinate convention. The project `{w,x,y,z}` to Cesium `(x,y,z,w)` conversion changes component order only. The new regression checks production parser/RotationModel plus the Cesium matrix against the hand vector, and separately confirms that the intentionally reversed composition is distinguishable. This is not a browser/GPU result or final scientific approval.

## Atlas and project compatibility

`atlas-fixture.json` is a fixture descriptor, **not** the current `PaleoAtlasManifest`: the latter is WebMercator/JPEG tiled imagery, whereas these SVGs are tiny standalone diagnostic frames. No route/server or tiled assets are claimed. A future local fixture adapter can map each SVG over `displayBounds`. Metadata includes nearest-age oracle, younger tie-break, out-of-range hide and a declared future missing-frame injection. Missing-frame behavior has **not** been executed. Raw values, where desired, come from the separately linked numeric file, never the SVG pixels.

`project-v2.json` is a currently parseable local ProjectSession snapshot with the legacy four layer types (Point=0, Raster=3, Atlas=4, PlateModel=5). Its `sourceRef` identifiers mirror the current fixed layer catalog; parsing alone does not load synthetic assets. This is not the uppercase backend RPC document format. `project-v2-unknown.json` adds markers at project/group/layer levels. Current parsing accepts it but loses the markers: preservation remains an open P2 acceptance condition, not a passing feature. Version 999 and truncated JSON are separate rejection samples. `future-multi-instance-layout.json` is a non-loadable acceptance layout; it does not define a fake v3 schema. Missing-resource and out-of-range-field project variants remain future work.

## Reproducibility and limits

`manifest.json` freezes bytes and SHA-256 for every other file in this directory (it excludes itself to avoid a self-hash). File entries identify synthetic source, formula and oracle. JSON uses UTF-8 and LF with a final newline. SVGs are literal 80×80 vectors: one solid rectangle, central cross, and age label. There are no remote requests. SHA values can be refreshed intentionally using Node `createHash('sha256').update(readFileSync(path)).digest('hex')`; never silently refresh hashes during validation.

Run `node scripts/validate-goal-fixtures.mjs` and `TIMEMACHINE_LIVE_ACCEPTANCE=0 npm test -- src/test/goal-fixtures.test.ts`. Deliberate rejection: `node scripts/validate-goal-fixtures.mjs --negative-case unclosed-ring` must exit 1 with `RING_CLOSED`. The validator covers this small corpus, not arbitrary GeoJSON topology. Rotation/project parser tests use production code; numeric and geometry checks validate fixture integrity only. Synthetic fixtures partially support FIX-02–11; they do not complete FIX-01/12/13/14, 30 renderer cells, multiview isolation, a multi-instance round trip or real numeric raster ingestion.
