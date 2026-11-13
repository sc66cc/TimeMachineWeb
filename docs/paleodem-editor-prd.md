# Paleogeographic Map Authoring Module PRD

> Authoritative feature PRD: [`docs/paleodem-editor-functional-prd.md`](./paleodem-editor-functional-prd.md).  
> Operational handoff: [`docs/paleodem-editor-handoff.md`](./paleodem-editor-handoff.md).  
> This document remains the decision/history record (D-001 through D-033).

> UI working name: **PaleoDEM Editor**  
> Document version: v0.37  
> Status: Prototype convergence; decisions D-001 through D-033 confirmed. Requirements Q&A is paused.  
> Scope: Product definition and concept prototype only  
> Canonical UI impact: None. This document does not change `docs/ui-reference/canonical/index.html`.

## 1. Product Summary

The Paleogeographic Map Authoring Module provides a desktop-style workspace for modifying PaleoDEM variables stored in NetCDF datasets.

The product combines two interaction models:

- **Photoshop interaction model**: direct canvas manipulation, a compact tool rail, a context-sensitive Tool Options bar, familiar selection modes, and keyboard modifiers.
- **QGIS organization and algorithm model**: a searchable Processing Toolbox, explicit algorithm parameters, preview before execution, deterministic processing, and inspectable history.

The module is formally named **Paleogeographic Map Authoring Module**. The shorter workspace label is **PaleoDEM Editor**.

## 2. Problem Statement

Editing PaleoDEM data currently requires users to translate geological intent into low-level array or GIS operations. This creates four problems:

1. Selecting the intended grid cells is slow and error-prone.
2. Terrain intent such as a ridge, valley, lake, or coastline is not represented as a reusable operation.
3. Direct NetCDF modification makes experimentation and rollback risky.
4. Scientific parameters and algorithm provenance are difficult to audit.

The module should let a geoscientist express edits visually while preserving the reproducibility and parameter transparency expected from GIS processing software.

## 3. Product Goals

### 3.1 Goals

- Let users select one or many raster cells with Photoshop-like interactions.
- Let users select cells using a QGIS-like expression editor.
- Support direct value editing for a single cell or a selection.
- Support geometry-driven terrain generation from points, lines, and areas.
- Make every selection and edit undoable and redoable.
- Preview changes before applying them.
- Preserve source NetCDF metadata and export an auditable result.
- Keep algorithms deterministic and versioned.

### 3.2 Non-goals for the first release

- General-purpose vector editing equivalent to all QGIS tools.
- Full Photoshop layer effects or image compositing.
- Editing multiple variables in one operation.
- Loading or rendering more than one age raster in the same canvas.
- Topology-aware plate reconstruction editing.
- Collaborative multi-user editing.
- Replacing the current 3D globe workspace.

## 4. Target Users

### Primary user

A paleogeographer or geoscientist who understands DEM values and geological features but should not need to write Python for routine map authoring.

### Secondary user

A technical reviewer who must inspect operation parameters, compare before and after surfaces, and reproduce an exported result.

## 5. Product Principles

1. **Direct manipulation first**: common actions happen on the canvas.
2. **Parameters remain explicit**: every algorithm has a QGIS-style parameter form.
3. **Preview before apply**: terrain generation never commits on the first click.
4. **Source data remains safe**: the confirmed model keeps the source NetCDF read-only.
5. **Selection is a first-class object**: it can be combined, inverted, saved, and used as an edit mask.
6. **Geometry and algorithm are separate**: users draw a point, line, or area, then choose how that geometry modifies the DEM.
7. **Every result is reproducible**: algorithm name, version, geometry, parameters, input revision, and random seed are recorded.

## 6. Terminology and English UI Labels

### 6.1 Module terminology

| Chinese requirement | Recommended English | Notes |
| --- | --- | --- |
| 古地理图编制模块 | Paleogeographic Map Authoring Module | Formal product name |
| PaleoDEMs 数据修改 | PaleoDEM Editing | Workspace purpose |
| 网格 | Grid Cell / Cell | Use `Cell`, not `Grid`, in compact UI labels |
| 选择 | Select / Selection | Tool group and selection state |
| 编辑 | Edit | Top-level capability |
| 历史 | History | Docked panel |
| 算法工具箱 | Processing Toolbox | Follows QGIS terminology |
| 编辑图层 | Edit Layer | Non-destructive operation container |

### 6.2 Selection terminology

| Chinese requirement | Recommended English UI label | Product interpretation |
| --- | --- | --- |
| 单网格选择 | Cell Select | Select one raster cell |
| 多网格选择 | Multi-cell Selection | Capability group, not a separate tool |
| 笔刷选择 | Quick Selection Brush | Brush-based expansion using local similarity |
| 魔棒 | Magic Wand | Click-based connected-region selection by tolerance |
| 按多边形选择 | Polygon Select | Draw a polygon and select covered cell centers |
| 按条件选择 | Select by Expression | QGIS-style expression selection |
| 新建选区 | New Selection | Replace the current selection |
| 添加到选区 | Add to Selection | Union |
| 从选区减去 | Subtract from Selection | Difference |
| 与选区交叉 | Intersect with Selection | Intersection |
| 取消选择 | Deselect | Clear active selection |
| 反选 | Inverse Selection | Select all currently unselected valid cells |

`Magic Wand` and `Quick Selection Brush` must be separate tools. They share the Photoshop `W` tool family but have different interactions and algorithms.

### 6.3 Editing terminology

| Chinese requirement | Recommended English UI label | Product interpretation |
| --- | --- | --- |
| 单网格值修改 | Cell Value Edit | Direct edit for one cell |
| 多网格值修改 | Selection Value Edit | Apply an operation to selected cells |
| 值直接修改 | Direct Value Editing / Value Operations | Set or offset values |
| 地形生成 | Terrain Feature Generation | Geometry-driven algorithms |
| 点 | Point Feature | One anchor point |
| 山峰 | Peak | Positive radial feature |
| 线 | Linear Feature | Polyline-driven feature |
| 山脊 / Ridge | Ridge | Normalize the duplicate terms into one tool |
| 峡谷 | Canyon | Narrow, steep negative linear feature |
| Valley | Valley | Wider, smoother negative linear feature |
| Barrier | Barrier | Hard or high-gradient linear constraint |
| Seam | Blend Seam | Smoothly blend elevations across a line to remove a visible or numeric seam |
| 海岸线 | Coastline | Move from Polygon to Linear Feature because it is a boundary line |
| 多边形 | Area Feature | Polygon-driven feature |
| 湖泊 | Lake Basin | Area set or depression with optional shoreline transition |
| 山脉 | Mountain Region | Area-based mountain field, optionally seeded by ridgelines |

## 7. Optimized Information Architecture

The original editing hierarchy is functionally correct but too deep for frequent use. The optimized model exposes geometry as a tool and the generated terrain type as a contextual option.

```text
PaleoDEM Editor
├── Select
│   ├── Cell Select
│   ├── Magic Wand
│   ├── Quick Selection Brush
│   ├── Polygon Select
│   └── Select by Expression
├── Edit
│   ├── Direct Value Editing
│   │   ├── Cell Value Edit
│   │   └── Selection Value Edit
│   └── Terrain Feature Generation
│       ├── Point Feature
│       │   └── Peak
│       ├── Linear Feature
│       │   ├── Ridge
│       │   ├── Valley
│       │   ├── Canyon
│       │   ├── Barrier
│       │   ├── Blend Seam
│       │   └── Coastline
│       └── Area Feature
│           ├── Lake Basin
│           └── Mountain Region
└── History
    ├── Undo
    ├── Redo
    └── Operation History
```

### 7.1 Workspace layout

| Region | Reference | Responsibility |
| --- | --- | --- |
| Left Tool Rail | Photoshop | High-frequency Select and Edit tools |
| Top Tool Options | Photoshop | Options for the active tool and selection mode |
| Center Raster Canvas | Photoshop + GIS map canvas | Direct manipulation and preview |
| Right Tool Properties | QGIS | Explicit parameters for the active tool |
| Right Processing Toolbox | QGIS | Searchable algorithm tree |
| Right Layers | Photoshop + QGIS | Source raster, Edit Layers, Selection Mask |
| Right History | Photoshop | Undoable operation list |
| Bottom Status Bar | QGIS | Longitude, latitude, row, column, value, selected count, CRS, zoom |

### 7.2 Minimal workbench and progressive disclosure

The product owner requested a button-first, minimal authoring interface inspired by Photoshop's tools and contextual controls, with QGIS-style algorithm discovery. The design is a professional editing workspace, not a documentation page.

- **Always visible:** compact application/document bar, active-tool options, icon rail, canvas comparison controls, current-tool basic parameters, primary actions and live selection/value status.
- **On demand:** a single right dock switches between Tool, Layers, History and Algorithms. Launching a tool or algorithm returns to Tool parameters. Advanced parameters and detailed selection statistics expand in place; their disclosure state survives rerenders and tool switches.
- **Dialogs:** clicking the document name opens variable and source-longitude settings. Help contains shortcuts, data contracts, limitations and the current open product question. Export defaults to source preservation; custom storage fields appear only when requested.
- **No persistent explanatory blocks:** no decision card on the canvas, repeated property-introduction paragraphs, performance-target footer or fake layer-management buttons. A compact synthetic-demo label remains visible.
- **Algorithm management:** provider/category tree, collapsed initially; bilingual search opens matching ancestors, suppresses empty groups and supports a clear no-results/reset state. Clearing the query restores the previous tree expansion. Unimplemented algorithms remain discoverable but disabled and labeled.
- **Selection flow:** choose a selection tool, interact with the canvas, then use Edit selection or the Values tool to apply a numeric operation.
- **Terrain flow:** choose geometry/algorithm, draw, adjust basic parameters, Preview, compare, then Apply to the current age only. Reusing work on a later age is a separate Copy From Previous Age action after the user enters that time slice. Any terrain parameter change invalidates the preview and disables Apply until a fresh preview passes range validation.
- **Keyboard:** existing selection modifiers and undo/redo remain; input editing and open dialogs never trigger document shortcuts. Dock tabs support arrow/Home/End navigation. Tab toggles panels only when the canvas is focused; normal controls retain native Tab traversal.
- **Desktop targets:** 1440×900, 1280×800 and 1024×768. The canvas gains room, controls remain readable, primary action buttons stay single-line and panels scroll independently.

This UI revision preserves D-001 through D-017, including ordered sequential composition. Question 18 (derived-delta refresh) remains open and is not implemented by this style change.

## 8. Confirmed Editing Model

### 8.1 Confirmed decision D-001

The editor uses a non-destructive editing model:

```text
Read-only Source NetCDF
        +
Ordered Edit Layers
        +
Active Selection Mask
        =
Rendered Working Surface
```

The user explicitly applies or exports the working surface to a new NetCDF file. The source file is never silently overwritten.

### 8.2 Edit Layer

Each Edit Layer stores ordered operations rather than a full duplicate raster whenever possible.

```text
EditOperation
- operationId
- operationType
- algorithmId
- algorithmVersion
- inputDatasetRevision
- sourceFileId
- ageMa
- targetVariable
- geometry
- selectionMaskReference
- parameters
- deterministicSeed
- createdAt
- status
```

### 8.3 Why this model was confirmed

- Undo and Redo remain reliable.
- Parameters can be reopened and adjusted.
- Before and after comparison is possible.
- Export is reproducible.
- The source NetCDF remains an audit baseline.

Decision D-001 is confirmed. Direct modification of the source NetCDF is outside the normal editing workflow. Any future overwrite workflow would require a separate explicit action and confirmation.

## 9. Functional Requirements

## 9.1 Dataset and Workspace

### FR-DATA-001 Open NetCDF

The user can open a NetCDF dataset and inspect:

- dimensions;
- coordinate variables;
- available data variables;
- units;
- geological age metadata;
- NoData or fill value;
- scale factor and offset;
- CRS or grid definition;
- chunking and compression metadata.

### FR-DATA-002 Choose an editable age file

Each geological age is stored in a separate NetCDF file containing a two-dimensional PaleoDEM variable. The user selects one source file and one editable variable. The UI must always display the active file, geological age, variable, and unit.

### FR-DATA-003 Group age files into a series

Related age files are grouped as a `PaleoDEM Series`. The series browser must:

- list one file per geological age;
- read age from a canonical NetCDF attribute when available;
- use a validated file-name rule only as a fallback;
- detect duplicate or missing ages;
- keep Edit Layers isolated by source file and age;
- switch source files without silently discarding pending edits.

### FR-DATA-004 Preserve metadata

Export must preserve compatible CF metadata, coordinate axes, units, fill values, geological age metadata, and unrelated variables.

### FR-DATA-005 Use a regular longitude-latitude grid

The first release targets a regular geographic grid:

```text
elevation(lat, lon)
lat(lat)
lon(lon)
```

Requirements:

- latitude and longitude coordinates are one-dimensional and monotonic;
- axis order and ascending or descending latitude are detected from metadata;
- source `row` and `col` remain the stable cell identity;
- display, polygon coverage, and terrain geometry use geographic coordinates;
- scientific radii and widths are expressed in kilometers, not cell counts;
- geographic distance accounts for longitude convergence toward the poles;
- longitude wrapping is explicit at the date line;
- export preserves the original axis values and order.

### FR-DATA-006 Normalize both longitude conventions

The importer accepts both `-180° <= lon < 180°` and `0° <= lon < 360°` source axes.

Requirements:

- detect the source convention from the coordinate array and metadata;
- reject ambiguous, duplicated, or non-monotonic longitude axes with a clear diagnostic;
- normalize geometry internally to the canonical range `-180° <= lon < 180°`;
- keep source `row` and `col` unchanged for Edit Layer targeting;
- treat the first and last longitude columns as cyclic neighbors;
- keep brush, Magic Wand, polygon, and linear terrain operations continuous across the date line;
- expose canonical `lon` and original `source_lon` in expressions;
- restore the original longitude values, convention, and axis order on export.

### FR-DATA-007 Use positive-up elevation semantics

The editable `E` or `elevation` variable uses positive-up semantics:

- `E > 0` represents land above sea level;
- `E = 0` represents sea level;
- `E < 0` represents ocean bathymetry below sea level;
- Peak and Ridge apply positive elevation deltas;
- Valley and Canyon apply negative elevation deltas;
- coastline tools treat `E = 0` as the primary boundary target;
- color ramps, expressions, statistics, validation, and export use the same sign convention;
- import warns when metadata conflicts with positive-up semantics.

### FR-DATA-008 Keep NoData cells editable

NoData is an editable cell state, not an invalid canvas location.

Requirements:

- detect `_FillValue`, `missing_value`, NaN, or a validated sentinel during import;
- Cell Select, Magic Wand, Quick Selection Brush, Polygon Select, and `is_nodata` expressions can select NoData cells;
- clicking NoData with Magic Wand selects its connected NoData region;
- selection totals include NoData, while numeric statistics report valid count and NoData count separately;
- numeric comparisons against NoData evaluate to false;
- `is_nodata = true` selects NoData explicitly;
- `Set Value` converts selected NoData cells into valid elevation values;
- relative operations that require an existing value must declare a base strategy, such as local valid-neighbor mean, nearest valid value, or explicit constant;
- the prototype uses local valid-neighbor mean for relative terrain previews;
- export preserves untouched NoData and removes the fill marker only from cells that received valid values.

### FR-DATA-009 Normalize and preserve both NoData encodings

The importer accepts IEEE NaN and finite `_FillValue` or `missing_value` sentinels in Float32 elevation files.

Requirements:

- inspect variable attributes before interpreting numeric values;
- record the source encoding kind, attribute name, and Float32 sentinel value in document metadata;
- classify both declared finite sentinels and non-finite NaN samples as NoData;
- create an internal `NoDataMask` before statistics, selection, or terrain algorithms run;
- use internal NaN as the working placeholder while keeping the mask as the authoritative state;
- reject ambiguous metadata when a declared finite sentinel is also intended as valid elevation;
- preserve untouched source samples bit-for-bit;
- when a NoData cell is filled, remove that cell from the mask and store its valid Float32 value;
- when exporting, restore the source file's original NaN or finite-sentinel convention and metadata;
- if both encodings occur in one source file, preserve its declared primary fill convention and classify both forms as input NoData.

### FR-DATA-010 Enforce a fixed elevation range

Every finite elevation value must remain within the inclusive range `-12000 m` to `12000 m`.

Requirements:

- NoData cells are excluded from range validation;
- import scans the source and reports pre-existing violations without modifying the file;
- a source with violations may open for diagnosis and repair;
- Preview may display out-of-range values and must report the violating-cell count and extent;
- Apply is blocked while the proposed working result contains any violation;
- Export is blocked while the document contains any violation;
- operations that repair existing violations are allowed to preview and apply only when their resulting document is valid;
- values are never silently clamped to the boundary;
- blocked operations do not create Edit Layer or History entries;
- the validation report records observed minimum, maximum, violation count, and affected coordinates.

### FR-DATA-011 Let the user map the elevation variable

The importer lists compatible numeric variables and requires the user to confirm which one is the PaleoDEM elevation variable.

Requirements:

- candidate variables must be two-dimensional over the confirmed latitude and longitude dimensions;
- candidate variables must be Float32 and use meter units;
- CF `standard_name`, `long_name`, units, dimensions, and common names contribute to a recommendation score;
- the recommendation is visible but never silently accepted;
- incompatible masks, coordinate variables, and non-meter variables are disabled with an explanation;
- the confirmed source variable name is stored in `PaleoDEMSeries.variableMapping`;
- subsequent age files reuse the series mapping after verifying that the variable remains compatible;
- a missing or incompatible mapped variable pauses opening and asks the user to remap;
- expression alias `E` resolves to the confirmed source variable;
- UI, History, operation manifests, and diagnostics show both `E` and the source variable name where needed;
- export writes changes back under the original source variable name without renaming it.

## 9.2 Selection

### FR-SEL-001 Selection operation modes

Every selection tool supports:

- `New Selection`;
- `Add to Selection`;
- `Subtract from Selection`;
- `Intersect with Selection`.

The mode is visible in the Tool Options bar. Keyboard modifiers temporarily override the visible mode.

| Interaction | Windows / Linux | macOS |
| --- | --- | --- |
| Add while selecting | Shift | Shift |
| Subtract while selecting | Alt | Option |
| Intersect while selecting | Shift + Alt | Shift + Option |
| Deselect | Ctrl + D | Command + D |
| Inverse Selection | Ctrl + Shift + I | Command + Shift + I |
| Pan canvas temporarily | Hold Space | Hold Space |
| Cycle Magic Wand / Quick Selection | W | W |
| Decrease / increase brush size | [ / ] | [ / ] |
| Undo | Ctrl + Z | Command + Z |
| Redo | Ctrl + Shift + Z | Command + Shift + Z |

### FR-SEL-002 Cell Select

- Clicking any raster cell, including NoData, selects it.
- The status bar shows row, column, coordinate, and current value.
- Add, Subtract, and Intersect modifiers follow FR-SEL-001.
- A selected cell has a high-contrast overlay that remains readable over all elevation colors.

### FR-SEL-003 Magic Wand

- Clicking a numeric cell selects connected cells whose values are within the configured tolerance.
- Clicking a NoData cell selects the connected NoData region.
- Parameters:
  - `Tolerance`;
  - `Contiguous`;
  - neighborhood: 4-connected or 8-connected;
  - optional valid-data mask;
  - selection operation mode.
- The options bar follows Photoshop terminology.
- The result displays a selected-cell count before any edit is applied.

### FR-SEL-004 Quick Selection Brush

- Pointer drag paints a candidate region.
- The brush expands selection using local value similarity and spatial adjacency.
- A stroke that begins on NoData treats NoData as its similarity class.
- Parameters:
  - `Size`;
  - `Hardness` or edge confidence;
  - `Tolerance`;
  - `Contiguous`;
  - selection operation mode.
- `[` and `]` update brush size without leaving the canvas.
- The brush cursor displays the current influence radius.
- One pointer stroke creates one History entry, not one entry per cell.

### FR-SEL-005 Polygon Select

The interaction follows the familiar Google Maps polygon drawing pattern:

- click to add a vertex;
- a preview edge follows the pointer;
- double-click or Enter completes the polygon;
- Backspace removes the last vertex;
- Escape cancels drawing;
- completed vertices can be dragged before applying;
- the closing segment is created automatically;
- cells whose centers fall inside the polygon are selected;
- an optional future mode may select any cell touched by the polygon boundary.

Holding Space temporarily pans the canvas without losing the unfinished polygon.

### FR-SEL-006 Select by Expression

The expression editor follows QGIS concepts.

Example:

```text
E > 0 AND E < 1000
```

Supported first-release fields:

- `E` and `elevation`, using positive-up values;
- `lon`, normalized to `-180° <= lon < 180°`;
- `source_lon`, preserving the source file convention;
- `lat`;
- `row`;
- `col`;
- `is_nodata`, which is true for editable NoData cells;
- active time or age metadata when available.

Supported first-release syntax:

- comparison: `>`, `>=`, `<`, `<=`, `=`, `!=`;
- boolean: `AND`, `OR`, `NOT`;
- parentheses;
- numeric constants;
- a bounded set of documented functions.

The editor must provide:

- syntax validation;
- field insertion;
- function help;
- result count preview;
- error location and explanation;
- selection operation mode;
- saved recent expressions.

### FR-SEL-007 Selection status

The UI always shows:

- selected cell count;
- selected valid-data count;
- value minimum, maximum, mean, and standard deviation;
- selection bounding extent;
- estimated affected area when cell area is known.

### FR-SEL-008 Use cyclic longitude and bounded latitude

Drawing and selection topology follows the regular longitude-latitude grid:

- the first and last longitude columns are cyclic neighbors;
- Magic Wand and Quick Selection Brush continue across the date line;
- Polygon Select unwraps longitude for inclusion tests near `±180°`;
- linear terrain geometry uses the shortest wrapped longitude path;
- operation geometry stores canonical longitudes plus explicit wrap information;
- latitude rows never wrap from north to south;
- the north and south grid edges are non-crossable boundaries;
- drawing vertices are clamped to the supported latitude extent;
- brush and flood-fill footprints are clipped at the polar rows;
- kilometer-based widths remain latitude-aware near a pole;
- no operation implicitly continues through a pole to the opposite longitude.

## 9.3 Direct Value Editing

### FR-EDIT-001 Cell Value Edit

- With one cell active, the user can enter a new value.
- The UI shows old value, new value, unit, and delta.
- Enter previews or commits according to the active preference.
- Escape cancels the pending change.

### FR-EDIT-002 Selection Value Edit

First-release operations:

- `Set Value`;
- `Add Offset`.

Later operations:

- multiply by factor;
- clamp to range;
- set NoData;
- interpolate from boundary;
- smooth selected cells.

Every operation shows the affected-cell count and before/after statistics before Apply. `Set Value` fills selected NoData cells. Relative operations must report which NoData base strategy they use and may not silently treat NoData as zero.

## 9.4 Terrain Feature Generation

### FR-TERRAIN-001 Common execution flow

Every terrain generator follows one flow:

```text
Choose geometry tool
→ Draw geometry
→ Configure algorithm parameters
→ Preview the current age
→ Inspect delta and statistics
→ Apply to the current age only
```

Every terrain generator emits a relative delta field:

```text
E_base = current working elevation or the explicit NoData base
ΔE = generated terrain delta
E_new = E_base + ΔE
```

Common parameters:

- delta amplitude;
- influence width or radius;
- cross-section profile;
- falloff function;
- smoothing iterations;
- active selection as an optional mask;
- NoData base strategy for relative algorithms;
- edge behavior;
- deterministic random seed;
- output Edit Layer.

### FR-TERRAIN-002 Point Feature: Peak

Input geometry: one point.

Minimum parameters:

- peak elevation delta;
- radius;
- profile: Gaussian, cone, or dome;
- asymmetry or ellipticity;
- rotation;
- falloff;
- optional roughness seed.

Preview displays the footprint, center, expected maximum, and affected-cell count.

### FR-TERRAIN-003 Linear Features

Input geometry: polyline.

| Tool | English label | Intended effect |
| --- | --- | --- |
| 山脊 | Ridge | Positive linear relief with a configurable cross-section |
| Valley | Valley | Broad negative linear relief |
| 峡谷 | Canyon | Narrower and steeper negative linear relief |
| Barrier | Barrier | Hard or high-gradient constraint line |
| Seam | Blend Seam | Generate the delta between the current surface and a smoothed seam surface |
| 海岸线 | Coastline | Apply a side-aware relative land or ocean elevation adjustment |

Common linear parameters:

- line width in kilometers;
- center delta amplitude;
- left and right falloff;
- longitudinal smoothing;
- end-cap behavior;
- optional side selection;
- optional profile preset.

`Blend Seam` computes a smoothed reference surface, then stores `ΔE = Eblend - Ebase`. Its parameters are blend width, blend strength, sampling distance, smoothing kernel, and edge-preservation level. It never stores an absolute replacement surface.

`Coastline` belongs under Linear Feature, not Area Feature. A coastline may reference an area or land-sea mask, but its primary editable geometry is a line.

### FR-TERRAIN-004 Area Features

Input geometry: polygon.

| Tool | English label | Intended effect |
| --- | --- | --- |
| 湖泊 | Lake Basin | Apply a negative interior delta with a controlled shoreline transition |
| 山脉 | Mountain Region | Apply a bounded positive mountain delta field inside an area |

`Lake Basin` parameters include depth delta, shoreline width, falloff, and interior smoothing.

`Mountain Region` parameters include elevation range, ridge orientation, roughness scale, edge falloff, and deterministic seed.

### FR-TERRAIN-005 Preview

- Preview must not change committed data.
- The map can toggle `Before`, `After`, `Difference`, and `Split View`.
- Difference view uses a diverging color ramp centered on zero.
- Preview displays min, max, mean delta, changed-cell count, and estimated changed area.
- Apply is disabled while required parameters or geometry are invalid.

### FR-TERRAIN-006 Processing algorithm contract

Each algorithm behaves as a versioned processing operator:

```text
Input raster slice
+ Geometry
+ Optional selection mask
+ Parameters
+ Algorithm version
+ Seed
= Delta tiles + diagnostics
```

The same inputs must produce the same result.

### FR-TERRAIN-007 Copy From a previous age

This requirement supersedes the rejected source-age Apply push design. Apply never copies work into other ages, and the Tool panel does not ask for target ages before Apply.

Cross-age reuse is a user-initiated pull from the new time slice:

1. The user enters or creates the target age, for example 90 Ma.
2. In that 90 Ma slice, the user clicks `Copy From Previous Age`.
3. The user chooses an earlier source age. Copy From defaults to the immediately previous available age and also lists every earlier age.
4. The UI shows the source age, the current target age, and what will be copied. Changing the source updates that preview immediately.
5. The user previews and confirms once. The system then performs that requested copy.

After copy, the 90 Ma result is independent from 100 Ma. Editing, previewing, disabling, or deleting work on 90 Ma does not change 100 Ma.

“Automatic” only means the system performs the requested copy after one explicit Copy From confirmation. It does not mean Apply on 100 Ma pushes changes into 90 Ma or 80 Ma.

Copy From offers two scopes in one dialog. Entire previous age is the default and copies the complete editable working state of the source age as the starting point for the current age. Selected content reveals a checklist of geological features or layers from the source age, and the user chooses what to bring. The dialog shows the source age, current target age, selected scope, content count, and a preview summary before one Confirm Copy. If the target age already contains work, Confirm Copy adds the copied content as a new group above that work and does not replace it. After Confirm Copy, the canvas switches to Difference of the current age before versus after that newly added group. If the source age later changes, the copied group stays as an independent snapshot. The group shows `来源已有更新 / Source has newer changes` and offers `查看更新 / Review update`. Detecting or reviewing that update does not change the target age.

## 9.5 History

### FR-HIST-001 Undo and Redo

- Every completed selection gesture is undoable.
- Every data edit is undoable.
- Undo and Redo restore both raster state and relevant selection state.
- A brush stroke is one command.
- A completed polygon selection is one command.
- A terrain Apply is one command for the current age only.
- Copy From Previous Age is a separate explicit command and is never triggered by Apply.

### FR-HIST-002 History panel

History entries use meaningful names:

- `Cell Select: row 231, col 840`;
- `Magic Wand: 12,482 cells`;
- `Select by Expression: E > 0 AND E < 1000`;
- `Set Value: 423 cells to 120 m`;
- `Peak: +2,400 m, radius 180 km`;
- `Ridge: 14 vertices`.

The panel supports filtering `All`, `Edits`, and `Selections`.

### FR-HIST-003 Checkpoints

The user can create a named checkpoint before a high-impact operation. Checkpoints do not replace operation-level Undo.

## 9.6 Export and Validation

### FR-OUT-001 Export new NetCDF

The default export creates a new NetCDF file. It must not overwrite the source without a separate explicit workflow and confirmation.

### FR-OUT-002 Export report

The export includes or accompanies an operation manifest containing:

- source file hash or revision;
- output file hash;
- source file, geological age, and active variable;
- algorithm operations and versions;
- parameters and seeds;
- changed-cell statistics;
- metadata warnings.

### FR-OUT-003 Validation

Before export, validate:

- dimensions and coordinates unchanged unless explicitly intended;
- NoData preserved;
- every finite elevation lies within the fixed inclusive range `-12000 m` to `12000 m`;
- no unexpected discontinuities at edit boundaries;
- no NaN or infinity introduced;
- metadata remains internally consistent.

### FR-OUT-004 Configure export storage layout

Export layout is configurable, with source preservation as the default.

Default behavior:

- preserve the source NetCDF-4 / HDF5 container;
- preserve compression algorithm and level;
- preserve chunk dimensions;
- preserve Shuffle, checksum, endian, and other storage properties when compatible;
- do not force internal `256 × 256` edit tiles onto the exported variable.

Advanced Export behavior:

- allow an explicit custom layout;
- offer a preset of Deflate level 4, Shuffle enabled, and `256 × 256` chunks;
- allow supported compression level and chunk dimensions to be changed;
- validate chunk dimensions against the variable dimensions and target container;
- show that changing storage layout rewrites the variable but does not change scientific values;
- record container, compression, level, Shuffle, chunk dimensions, and preservation mode in the operation manifest;
- run the same value-range, NoData, coordinate, Float32, and metadata validation as default export.

### FR-OUT-005 Require NetCDF-4 / HDF5

The first release supports only NetCDF-4 / HDF5 for import and export.

Requirements:

- inspect the file signature before parsing the data model;
- reject NetCDF-3 classic, 64-bit offset, and CDF-5 inputs with a clear unsupported-container diagnostic;
- never silently convert a rejected NetCDF-3 file;
- every exported copy remains NetCDF-4 / HDF5;
- Preserve Source Layout keeps compatible NetCDF-4 compression, chunks, filters, and storage properties;
- Advanced Export keeps the container fixed and exposes only supported NetCDF-4 storage controls;
- operation manifests record `container: netcdf-4`;
- documentation names conversion to NetCDF-4 as an external preprocessing requirement for legacy files.

## 9.7 Bilingual Interface

### FR-UX-001 Show Chinese and English together

The requirements-discussion prototype and the authoring workspace show Chinese and English simultaneously.

Requirements:

- Chinese appears first and English second on primary controls;
- icon-only tools use bilingual accessible names and hover titles; short visible bilingual labels remain on parameters, primary actions, dock tabs and algorithm entries;
- explanatory copy belongs in contextual disclosures or dialogs, not permanent canvas overlays;
- menus, tools, parameters, algorithms, layers, history, status, dialogs, hints, and errors are bilingual;
- file names, NetCDF variable names, expression fields, units, CRS identifiers, and algorithm IDs are not translated;
- keyboard shortcuts remain platform-native and receive bilingual descriptions;
- bilingual labels must not wrap or truncate critical desktop actions at the target viewport;
- the first prototype does not require a language-mode toggle.

## 10. QGIS-style Processing Toolbox

The Processing Toolbox groups algorithms by purpose rather than by drawing gesture.

```text
PaleoDEM Provider
├── Raster Selection
│   ├── Select by Expression
│   ├── Select Value Range
│   └── Grow / Shrink Selection
├── Raster Value Operations
│   ├── Set Value
│   ├── Add Offset
│   └── Smooth Selection
├── Terrain Generation
│   ├── Point Features
│   │   └── Peak
│   ├── Linear Features
│   │   ├── Ridge
│   │   ├── Valley
│   │   ├── Canyon
│   │   ├── Barrier
│   │   ├── Blend Seam
│   │   └── Coastline
│   └── Area Features
│       ├── Lake Basin
│       └── Mountain Region
└── QA and Validation
    ├── Surface Difference
    ├── Seam Residual Check
    └── NetCDF Metadata Check
```

The Tool Rail launches high-frequency tools. The Processing Toolbox exposes the same capabilities for discoverability, search, parameter reuse, and future batch processing.

## 11. Core User Flows

### Flow A: Select an elevation band and set a value

1. Open a PaleoDEM Series.
2. Choose one age file and confirm its mapped elevation variable.
3. Open `Select by Expression`.
4. Enter `E > 0 AND E < 1000`.
5. Preview count and statistics.
6. Apply selection.
7. Open `Direct Value Editing`.
8. Choose `Set Value` or `Add Offset`.
9. Preview before/after statistics.
10. Apply to the active Edit Layer.

### Flow B: Quick-select a connected shelf region

1. Activate `Magic Wand` or `Quick Selection Brush` with `W`.
2. Set Tolerance and Contiguous.
3. Click or paint the target shelf.
4. Hold Shift to add missed areas.
5. Hold Alt or Option to remove spillover.
6. Inspect selected count and value range.
7. Continue to a value operation or terrain generator.

### Flow C: Generate a ridge

1. Activate `Linear Feature`.
2. Choose `Ridge` in Tool Properties.
3. Click vertices along the intended axis.
4. Double-click or press Enter to complete.
5. Configure amplitude, width, profile, and falloff.
6. Preview in Difference or Split View.
7. Apply to the active Edit Layer.
8. Rename the history entry if needed.

### Flow D: Generate a lake

1. Activate `Area Feature`.
2. Choose `Lake Basin`.
3. Draw and refine a polygon.
4. Set the negative depth delta, shoreline width, and falloff.
5. Preview.
6. Apply.
7. Export a new NetCDF after validation.

### Flow E: Copy finished work into a later age

1. Finish and Apply work on 100 Ma.
2. Enter the new 90 Ma time slice.
3. Click `Copy From Previous Age`.
4. Choose 100 Ma as the source if it is not already selected.
5. Choose entire previous age or selected content. Entire previous age is the default. Selected content shows a checklist such as Coastline, Ridge, and Basins / Edit Layers.
6. Review the source age, current target age, selected scope, content count, and preview summary, then confirm once.
7. If 90 Ma already has work, the copied content appears as a new From 100 Ma group above that work. Existing 90 Ma work stays.
8. The canvas switches to Difference of 90 Ma before versus after that copied group, with the group selected and labeled. The user can switch to After, Before, or Split View.
9. Continue editing 90 Ma on its own. 100 Ma does not change.

## 12. State and Data Model

### 12.1 Workspace state

```text
PaleoDEMDocument
- sourceSeries
- sourceFile
- ageMa
- activeVariable
- seriesVariableMapping
- gridModel: regular-lon-lat
- longitudeConvention
- canonicalLongitudeRange: [-180, 180)
- longitudeAxis
- latitudeAxis
- viewState
- editLayers[]
- activeSelection
- history
- checkpoints[]
```

### 12.2 Selection state

```text
SelectionMask
- maskId
- dimensions
- tileIndex
- selectedCount
- validSelectedCount
- statistics
- sourceDescription
```

Selection masks should be bit-packed or tiled. They must not be represented as millions of Vue reactive booleans.

### 12.3 Runtime separation

- Vue owns UI state and operation metadata.
- A raster worker owns selection and edit computation.
- GPU textures own viewport rendering and preview overlays.
- IndexedDB or an equivalent bounded local store owns recoverable Edit Layer tiles.
- The original NetCDF and full raster arrays must not be copied into Vue reactive state.

## 13. Performance and Reliability Requirements

### NFR-001 Interaction latency

- Pointer feedback: under 16 ms target, under 50 ms maximum perceived latency.
- Brush selection update: under 50 ms for the visible viewport.
- Cell value inspection: under 50 ms after data is resident.
- Undo or Redo for a viewport-scale edit: under 200 ms target.

### NFR-002 Progressive processing

Large selection or terrain operations run tile-by-tile. The UI displays progress and supports cancellation. Partial results never become committed Edit Layer state.

### NFR-003 Confirmed grid and memory envelope

The maximum first-release grid is `3600 × 1800`, or 6,480,000 cells per age file.

Memory and execution requirements:

- one decoded Float32 variable is approximately 24.7 MiB;
- the base raster may reside in a dedicated Worker, but not in Vue reactive state;
- processing and rendering use recommended `256 × 256` tiles, about 120 tiles at the maximum grid size;
- the Selection Mask uses a bitset or equivalent compact representation, approximately 0.77 MiB at maximum size;
- Undo and Redo store affected-tile deltas or reversible operations, never full-raster snapshots;
- Preview reuses base tiles and stores only changed tiles or deltas;
- full-raster algorithms execute progressively in a Worker, report progress, and support cancellation;
- viewport and GPU caches are bounded and evictable;
- the target peak browser memory for one open age file is under 192 MiB, excluding browser and Cesium baseline overhead;
- server-side out-of-core processing is a fallback, not the primary path for the confirmed first-release envelope.

### NFR-004 Float32 precision

The source elevation variable is Float32 in meters.

Requirements:

- no `scale_factor` or `add_offset` is required for the first-release elevation contract;
- the Worker stores source and materialized working values in `Float32Array` buffers;
- algorithm parameters and intermediate calculations may use higher precision;
- changed values are rounded to Float32 once when committed to an Edit Layer or exported;
- untouched source cells remain bit-for-bit unchanged;
- repeated preview must not repeatedly quantize committed data;
- overflow, infinity, and unintended NaN values block Apply and Export;
- export writes a Float32 elevation variable with meter units and preserves the confirmed NoData encoding.

### NFR-005 Determinism

Terrain generation results are deterministic for the same input revision, algorithm version, geometry, parameters, and seed.

### NFR-006 Recovery

An unexpected tab close must not corrupt the source. Recoverable edit state should be restored from the latest safe local checkpoint when feasible.

### NFR-007 Accessibility

- All tools have accessible names.
- Keyboard access covers selection modes, Undo, Redo, Apply, and Cancel.
- Selection overlays remain distinguishable without relying on hue alone.
- Focus indicators remain visible over the dark authoring UI.

## 14. MVP Scope

### P0: Required for the first usable vertical slice

- Open one supported NetCDF PaleoDEM.
- Open one age-specific NetCDF, choose a compatible Float32 meter variable, and remember the mapping for the series.
- Auto-detect and preserve either supported longitude convention.
- Show Chinese-English labels for the complete authoring workflow.
- Cell Select.
- Magic Wand.
- Quick Selection Brush.
- Polygon Select.
- Select by Expression with comparisons and boolean operators.
- New, Add, Subtract, and Intersect selection modes.
- Set Value and Add Offset.
- Select and fill NoData cells.
- Process grids up to `3600 × 1800` with tiled Worker execution and delta-based history.
- Peak generator.
- Ridge and Valley generators.
- Lake Basin generator.
- Preview and Difference view.
- Non-destructive Edit Layer.
- Undo, Redo, and History panel.
- Export to a new NetCDF.
- Operation manifest and basic validation.

### P1: After the vertical slice

- Canyon, Barrier, Blend Seam, Coastline, and Mountain Region.
- Saved selections and named masks.
- Advanced expression functions.
- Clamp, NoData, interpolation, and smoothing operations.
- Editable algorithm history parameters.
- Key-age interpolation of intermediate ages.
- Server-side or worker-farm execution for datasets beyond browser limits.

## 15. Acceptance Criteria for the Vertical Slice

1. A user can open a real PaleoDEM NetCDF without changing the source file.
2. The user can select cells with all five selection tools.
3. Shift, Alt or Option, and Shift + Alt or Option produce Add, Subtract, and Intersect behavior.
4. `E > 0 AND E < 1000` produces a validated selection and reports count and statistics.
5. A direct value edit changes only selected cells; `Set Value` can convert selected NoData cells to valid elevations.
6. Peak, Ridge, Valley, and Lake Basin support Draw, Configure, Preview, and Apply.
7. Preview does not modify committed data.
8. Undo and Redo restore exact cell values and selection state.
9. Export creates a new NetCDF with compatible dimensions, coordinates, and metadata.
10. Replaying the operation manifest against the same source produces the same changed cells and values within defined numeric tolerance.
11. A large operation can be cancelled without committing partial output.
12. No full raster is stored as Vue reactive cell objects.
13. Equivalent files using `[-180°, 180°)` and `[0°, 360°)` produce equivalent selections and terrain edits after normalization, while export preserves each source convention.
14. NoData cells can be selected, counted separately, filled with `Set Value`, edited by terrain algorithms with an explicit base strategy, undone, redone, and exported correctly.
15. A `3600 × 1800` grid opens and edits without Vue cell objects or full-raster Undo snapshots; full-raster processing reports progress and can be cancelled.
16. Untouched Float32 cells round-trip bit-for-bit, while changed values are rounded once to finite Float32 meters before commit and export.
17. NaN and finite-sentinel source files produce equivalent internal NoData selections and edits, while export restores each file's original encoding and fill metadata.
18. Preview reports values outside `[-12000, 12000] m`; Apply and Export remain blocked until the resulting document has zero violations, and blocked actions create no History entry.
19. The importer recommends compatible elevation variables, requires user confirmation, reuses the mapping across age files, and exports under the original variable name.
20. Export defaults to preserving source compression and chunks; Advanced Export can use Deflate level 4, Shuffle, and custom chunks, and all chosen settings appear in the operation manifest.
21. NetCDF-4 / HDF5 files import and export normally, while NetCDF-3 variants are rejected before data parsing with a clear conversion requirement.
22. Selection and terrain geometry remain continuous across the date line, while brush, flood-fill, polygons, and terrain geometry never wrap from the north polar row to the south polar row.
23. Every terrain operation stores a Float32 `ΔE` field and materializes results as `E_new = E_base + ΔE`; no terrain generator stores direct replacement elevations.
24. Enabled Edit Layers compose bottom-to-top from the immutable source; each terrain layer materializes `E_out = E_in + ΔE`; disabled layers are skipped; Direct Set Value remains an absolute masked write at its stack position; the operation manifest records layer order, enabled state, operation IDs, and deterministic parameters.
25. Derived layers whose `ΔE` recipe sampled `E_in` are marked stale when a lower dependency changes; the last cached `ΔE` remains visible; active stale layers block export; explicit Recompute regenerates `ΔE` once as Float32 and writes a history or manifest event. Pure fixed `ΔE` layers do not recompute.
26. Explicit Recompute on a selected stale derived layer rebuilds the enabled affected upper closure bottom-to-top, skips fixed `ΔE` and disabled derived layers, labels the affected count and order, and writes one cascade history or manifest event with deterministic per-layer order.
27. If an explicit cascade recompute fails, violates the hard elevation range, or is cancelled, no affected layer cache is committed; the pre-action stale or fresh state is restored, enabled stale layers still block export, and History records one failed-cascade event with the failed layer, reason, and rollback count.
28. Local committed edits persist in a `.pdemproj` snapshot and enqueue idempotent cloud change records; only server acknowledgement advances the cloud revision and clears the outbox; a failed atomic cascade enqueues no committed project change.
29. A cloud project has at most one write lease; other clients remain read-only; Sync now revalidates the lock token and base revision; if the write lease is uncertain, project-changing actions stay read-only while the local package and pending outbox are preserved.
30. The user enters a later time slice such as 90 Ma, starts Copy From Previous Age, chooses an earlier source such as 100 Ma, reviews source, target, and copy preview, and confirms once; Apply on 100 Ma never copies into other ages; after copy, 90 Ma is independent from 100 Ma.
31. Copy From offers entire previous age as the default and selected content as an explicit alternative; selected copy requires at least one chosen feature or layer; one Confirm Copy performs that scope as an independent 90 Ma result.
32. If 90 Ma already has editable work, Confirm Copy adds the copied content as a new From 100 Ma group above that work and does not replace it. The group can be shown, hidden, or deleted as one unit; Undo Copy From removes the whole group and restores the previous 90 Ma workspace.
33. After Confirm Copy, the canvas automatically switches to Difference of 90 Ma before versus after the new From 100 Ma group, keeps that group selected, and labels the copied contribution. The user can switch to After, Before, or Split View. Hiding, deleting, or undoing the group updates or removes that cue. The prototype does not load a live 90 Ma raster.
34. Copy From defaults to the immediately previous available age and lets the user choose another earlier age. On 80 Ma, Copy From opens with 90 Ma selected and lists 90 Ma and 100 Ma, never 80 Ma or a later age. Changing the source updates the preview, result wording, and group name such as `From 90 Ma` or `From 100 Ma`. Closing and reopening restores the default previous age. On 90 Ma, the default remains 100 Ma.
35. After 80 Ma copies from draft 90 Ma, a later 90 Ma change leaves the `From 90 Ma` group unchanged and shows `Source has newer changes`. Review update shows the current 80 Ma copy, the original copied 90 Ma version, and the latest 90 Ma state, and does not mutate 80 Ma or add a pending edit. A group copied from finished 100 Ma with no newer source changes shows no update badge. Bringing in the newer source is not yet decided.

## 16. Decisions, Risks, and Open Questions

### Confirmed product decisions

#### D-001: Non-destructive Edit Layers

- Status: Confirmed by the product owner.
- Source NetCDF: Read-only.
- Working changes: Ordered Edit Layers.
- Preview: Never commits source data.
- Output: Export a new NetCDF plus an operation manifest.

#### D-002: Seam means Blend Seam

- Status: Confirmed by the product owner.
- Purpose: Smoothly merge elevations across two sides of a drawn line.
- Effect: Remove a visible or numeric discontinuity.
- Parameters: Width, strength, sampling distance, smoothing kernel, and edge preservation.
- Exclusions: It does not create a Breakline and does not duplicate Barrier behavior.

#### D-003: One NetCDF per geological age

- Status: Confirmed by the product owner.
- File shape: One two-dimensional PaleoDEM per NetCDF file.
- Series model: Related age files are grouped into a PaleoDEM Series.
- Edit target: `sourceFileId + ageMa + variable`.
- Export scope: One new NetCDF for each edited age file.
- Exclusions: The first release does not require an in-file `age` or `time` dimension.

#### D-004: Regular longitude-latitude grid

- Status: Confirmed by the product owner.
- Raster shape: `elevation(lat, lon)`.
- Coordinates: One-dimensional latitude and longitude arrays.
- Cell identity: Source `row + col`.
- Geometry: Geographic longitude and latitude.
- Distance parameters: Kilometers with latitude-aware calculations.
- Exclusions: Projected, curvilinear, cube-atlas, and custom grids are outside the first-release input contract.

#### D-005: Support both longitude conventions

- Status: Confirmed by the product owner.
- Accepted source ranges: `[-180°, 180°)` and `[0°, 360°)`.
- Internal geometry range: `[-180°, 180°)`.
- Source identity: Original `row + col` and longitude axis remain unchanged.
- Date line: First and last columns are cyclic neighbors.
- Expressions: `lon` is canonical and `source_lon` is original.
- Export: Restore the source convention and coordinate order.

#### D-006: Positive-up elevation with sea level at zero

- Status: Confirmed by the product owner.
- Land: `E > 0`.
- Sea level: `E = 0`.
- Ocean bathymetry: `E < 0`.
- Positive terrain operations: Peak and Ridge.
- Negative terrain operations: Valley and Canyon.
- Coastline reference: `E = 0`.

#### D-007: NoData cells are always editable

- Status: Confirmed by the product owner.
- Selection: All selection tools may include NoData.
- Expression: `is_nodata = true` selects NoData.
- Statistics: Total, valid, and NoData counts are separate.
- Absolute edit: `Set Value` fills NoData.
- Relative edit: Requires an explicit base-value strategy.
- Export: Untouched NoData remains NoData; filled cells become valid values.

#### D-008: Maximum grid is 3600 × 1800

- Status: Confirmed by the product owner.
- Maximum cells per age file: 6,480,000.
- Float32 payload: Approximately 24.7 MiB per variable.
- Primary execution path: Browser Worker with tiled processing.
- Recommended tile size: `256 × 256`, about 120 tiles at maximum dimensions.
- Selection representation: Compact bitset, approximately 0.77 MiB.
- History representation: Reversible operations or affected-tile deltas, never full-raster snapshots.
- Target peak memory: Under 192 MiB for one open age file, excluding browser and Cesium baseline overhead.
- Server processing: Fallback rather than the first-release primary path.

#### D-009: Elevation is Float32 in meters

- Status: Confirmed by the product owner.
- Source type: Float32.
- Unit: Meters.
- Packing: No `scale_factor` or `add_offset` in the first-release contract.
- Working representation: `Float32Array`.
- Intermediate calculations: May use higher precision.
- Commit and export: Round changed values once to finite Float32.
- Unchanged cells: Preserve source bits.

#### D-010: Support NaN and finite NoData sentinels

- Status: Confirmed by the product owner.
- Accepted encodings: IEEE NaN and finite `_FillValue` or `missing_value`.
- Internal state: `NoDataMask` plus NaN working placeholders.
- Import: Normalize both encodings before numeric processing.
- Editing: Filled cells leave the mask and receive valid Float32 values.
- Export: Restore the source encoding and fill metadata.
- Mixed source: Treat both forms as NoData while preserving the declared primary convention.

#### D-011: Fixed hard elevation range

- Status: Confirmed by the product owner.
- Inclusive valid range: `-12000 m` to `12000 m`.
- Preview: Allowed, with explicit violation count and locations.
- Apply: Blocked when the proposed result has any violation.
- Export: Blocked while the working document has any violation.
- Clamping: Never automatic.
- History: Blocked operations create no entry.
- Existing invalid source: May open for diagnosis and repair but cannot export until valid.

#### D-012: User-confirmed elevation variable mapping

- Status: Confirmed by the product owner.
- Discovery: List compatible two-dimensional Float32 meter variables.
- Recommendation: Rank candidates using CF metadata and common names.
- Authority: The user makes the final selection.
- Scope: Save the mapping for the complete PaleoDEM Series.
- Reuse: Validate and reuse it for later age files.
- Expressions: `E` aliases the mapped source variable.
- Export: Preserve the original variable name.

#### D-013: Configurable export layout, preserve by default

- Status: Confirmed by the product owner.
- Default: Preserve source compression, chunks, and compatible storage properties.
- Advanced Export: Allow custom compression and chunk dimensions.
- Standard preset: Deflate level 4, Shuffle enabled, `256 × 256` chunks.
- Independence: Internal edit tiles do not determine output chunks.
- Validation: Both modes use the same scientific and metadata checks.
- Audit: Record all export layout settings in the operation manifest.

#### D-014: NetCDF-4 / HDF5 only

- Status: Confirmed by the product owner.
- Import: Accept only NetCDF-4 / HDF5.
- Export: Always write NetCDF-4 / HDF5.
- NetCDF-3: Reject before data parsing with an explicit diagnostic.
- Conversion: Never silent; legacy conversion is external preprocessing.
- Preserve mode: Preserve only compatible NetCDF-4 storage properties.
- Advanced mode: Container is fixed; compression and chunks remain configurable.

#### D-015: Date line seamless, poles bounded

- Status: Confirmed by the product owner.
- Longitude: Cyclic across `±180°`.
- Latitude: Bounded at the north and south grid edges.
- Selection: Wrap in longitude and clip in latitude.
- Terrain geometry: Use wrapped shortest paths without polar continuation.
- Manifest geometry: Canonical longitude plus explicit wrap information.
- Pole crossing: Not supported in the first release.

#### D-016: Terrain generation uses relative deltas only

- Status: Confirmed by the product owner.
- Storage: Every terrain operation stores `ΔE`, not absolute replacement elevations.
- Composition equation: `E_new = E_base + ΔE`.
- NoData: `Ebase` comes from the selected explicit base strategy.
- Peak, Ridge, Mountain Region: Positive delta fields.
- Valley, Canyon, Lake Basin: Negative delta fields.
- Coastline: Side-aware relative delta field.
- Blend Seam: Compute a smooth reference, then store `Eblend - Ebase`.
- Direct Value Editing: `Set Value` remains an absolute non-terrain operation.

#### D-017: Ordered sequential Edit-Layer composition

- Status: Confirmed by the product owner.
- Source DEM: Immutable, evaluated first, shown at the bottom of the layer stack.
- Evaluation order: Enabled Edit Layers run bottom-to-top.
- Input: Each layer receives `E_in` as the materialized output of all enabled layers below it.
- Terrain operations: `E_out = E_in + ΔE`.
- Direct Value Editing: `Set Value` remains an absolute masked write at its stack position.
- Disabled layers: Skipped and do not contribute to `E_in` of layers above.
- Manifest: Record stable layer order, enabled state, operation IDs, and deterministic parameters.
- History: Undo and redo conceptually include visibility and reorder.
- Dependency refresh: Resolved by D-018.

#### D-018: Mark stale and require explicit recompute

- Status: Confirmed by the product owner.
- Scope: Only derived layers whose `ΔE` recipe sampled `E_in`. Pure fixed `ΔE` layers do not become stale.
- Triggers: A lower dependency's values, parameters, masks, order, enabled state, or operation set changes.
- Cache: The stale layer keeps its last cached `ΔE` and remains viewable in canvas and Difference view.
- Warning: Show a conspicuous bilingual stale state. Never silently recompute.
- Export: Active stale layers block export. Disabled stale layers are excluded and do not block export. Re-enabling restores the retained stale state.
- Recompute: Explicit Recompute regenerates `ΔE` from current `E_in`, replaces the cache once with Float32 rounding, updates statistics and provenance, and writes an auditable history or manifest event.
- Recompute scope: Resolved by D-019.

#### D-019: Explicit recompute cascades through enabled affected upper layers

- Status: Confirmed by the product owner.
- Closure: Start at the selected stale derived layer and include every enabled affected upper derived layer.
- Order: Execute bottom-to-top. Each recomputed layer uses the latest materialized `E_in` from the just-refreshed lower stack.
- Fixed ΔE: Skip recomputation because the cache is input-independent; still materialize the layer in the stack.
- Disabled derived layers: Skip and retain stale. Re-enabling restores the retained stale state and can start a new cascade.
- User action: Explicit. The command is not silent auto recompute. The UI labels the number and order of affected layers before execution.
- History: One parent cascade event plus deterministic per-layer order and provenance in the History and operation manifest.
- Failure: Resolved by D-020.

#### D-020: Cascade recompute is atomic all-or-nothing

- Status: Confirmed by the product owner.
- Snapshot: Before cascade, snapshot cache, status, statistics, and provenance for every affected layer.
- Staging: Compute into temporary tile buffers. Do not mutate live cached `ΔE` or live freshness while processing.
- Validation: Every staged layer must pass algorithm success, cancellation state, NoData/base behavior, one Float32 rounding, and the hard elevation range.
- Commit: Replace live caches in one atomic transition only after every affected layer succeeds.
- Failure: On algorithm error, hard-range violation, or cancellation, discard all staged output and restore the exact pre-action live state. No partial layer result is committed.
- Export: The affected chain remains in its pre-action stale or fresh state. Enabled stale layers still block export.
- History: Record one auditable failed-cascade event with failed layer, reason, and rollback count. Do not record successful per-layer commit events. Retry remains deterministic.
- Storage: Staging is tile or buffer based, never a second Vue reactive raster.

#### D-021: Local `.pdemproj` package plus cloud project database sync

- Status: Confirmed by the product owner.
- Local package: One portable `.pdemproj` archive is the offline editable snapshot.
- Contents: Project metadata, ordered layer recipes and state, dependency and stale flags, history and manifest state, source NetCDF reference plus fingerprint and optional embedded source copy, last acknowledged cloud revision, pending local outbox, and cache references or data.
- Autosave versus sync: Local edits are durable in `.pdemproj` before any network sync.
- Cloud project: Stable `project_id` and a monotonic revision. The cloud database records idempotent structured change records: operation or change ID, base revision, actor or device identifier, timestamp, layer or operation payload, and hash.
- Credentials: None in product files. No vendor schema is specified.
- Sync: Upload pending records in order. Only server acknowledgement advances `last_synced_revision` and removes them from the outbox. Retry by operation ID must not duplicate changes.
- Large binaries: NetCDF and `ΔE` tiles are content-addressed blob or object references controlled by database metadata. Whether those blobs live in the database or object storage remains technical discovery; do not store arbitrary large binaries directly in rows.
- Prototype: Simulation only. No backend or network claim.

#### D-022: First-release cloud single-writer lease lock

- Status: Confirmed by the product owner.
- Cardinality: One cloud project has at most one active write lease.
- Readers: Other devices or users may open the project read-only.
- Acquire: Obtain a lease before entering edit mode or acknowledging synced project changes.
- Lease record: `project_id`, owner or actor, device or session ID, an opaque lock token, base cloud revision, `issued_at`, and `expires_at`.
- Token handling: Keep the opaque lock token internal; never expose it in UI, logs, project manifests, or audit payloads.
- Renewal: The active writer renews by heartbeat. Do not hardcode a production TTL in this draft.
- Release: Normal close releases explicitly. Crash or disconnect eventually releases by TTL expiry.
- Authority: The server revalidates lock token and base revision on every sync acknowledgement. Client UI checks are not the authority.
- Audit: Record acquire, renew, release, expiry, rejection, and any authorized force-unlock. Roles and admin policy remain unspecified.
- Read-only client: Selection, view, and Difference remain usable. Committed edits, cascade recompute, undo or redo that change project state, and Sync now are disabled and guarded. The local `.pdemproj` and pending outbox stay intact.
- Engineering default when the lease is uncertain: Preserve the local `.pdemproj` and pending outbox. Switch project-changing actions to read-only until a write lease is reacquired. Selection, view, and Difference remain usable. TTL, heartbeat recovery, and server revalidation remain engineering discovery. This default is not a numbered product decision.

#### D-023: Copy From a previous age into the current time slice

- Status: Confirmed by the product owner.
- Supersedes: The rejected design where Apply on the source age, such as 100 Ma, automatically copied work into selected later ages. Apply does not propagate to other ages. The Tool panel does not collect target ages before Apply.
- Trigger: The user is already in the new target time slice, for example 90 Ma, and explicitly starts `Copy From Previous Age`.
- Source: Confirmed in D-027. Copy From defaults to the immediately previous available age and lets the user choose another earlier age.
- Confirmation: The UI shows the source age, the current target age, and what will be copied. The user previews and confirms once. The system then performs that requested copy.
- Independence: After copy, the 90 Ma result is independent from 100 Ma. Editing 90 Ma does not change 100 Ma.
- Automatic meaning: The system performs the requested copy after one explicit Copy From confirmation. It never means source-age Apply pushes changes into other ages.
- Copied payload: Confirmed in D-024. Copy From offers entire previous age by default, or selected geological features and layers.
- First-release wording: Geological features and reusable operations. The prototype shows the target-side Copy From dialog with both scope modes. It does not load later-age rasters. Confirming Copy From records an independent simulated copy and, when 90 Ma already has work, adds that copy as a new group above the existing 90 Ma layers.

#### D-024: Copy From offers entire previous age and selected content

- Status: Confirmed by the product owner.
- Dialog modes: The Copy From dialog always offers both scopes. The user is already in the target age, for example 90 Ma, and is copying from an earlier age, for example 100 Ma.
- Entire previous age: Default and common path. Use the complete editable 100 Ma working state as the 90 Ma starting point.
- Selected content: The user switches to this mode and sees a checklist of geological features or layers from 100 Ma, such as Coastline, Ridge, and Basins / Edit Layers, then chooses what to bring.
- Preview: Before confirmation, the dialog shows source age, current target age, selected scope, content count, and a preview summary.
- Confirm: One Confirm Copy performs the requested scope. Selected content requires at least one chosen item. After copy, 90 Ma is independent from 100 Ma.
- Prototype: Labeled simulation only. Confirm is enabled when the chosen scope is valid. The 90 Ma raster is not loaded. History and pending sync record the grouped Copy From result. Apply on the source age still never copies into other ages.
- Existing target work: Confirmed in D-025. Copy From adds a new group above existing 90 Ma work and does not replace it.

#### D-025: Copy From adds a new group above existing 90 Ma work

- Status: Confirmed by the product owner.
- Keep existing work: If 90 Ma already has editable work, such as a 90 Ma coastline, that work stays. Confirm Copy never replaces the current 90 Ma workspace.
- Add as a group: The copied 100 Ma content appears as one new group in the 90 Ma Layers panel, named clearly such as `来自 100 Ma / From 100 Ma`, placed above the existing 90 Ma editable layers, and selected after confirmation.
- Group contents: The group holds either the entire previous-age working map or the selected copied items from D-024.
- One unit: The user can show or hide the group, delete it as one unit, or request to move it. After confirmation, existing 90 Ma work remains available for comparison.
- Undo: Undo Copy From removes the entire added group and restores the previous 90 Ma workspace in one step. Redo restores the group.
- Check the result: Difference or preview can identify that group's contribution. The 100 Ma source remains unchanged.
- Confirmation text: Confirm Copy must say the copy was added and existing 90 Ma work was kept.
- Prototype: Labeled layer-stack simulation. The 90 Ma raster is still not loaded. Move is shown as not implemented. Child items inside the group are a summary, not separately linked layers.
- After-copy canvas view: Confirmed in D-026.

### Product-owner question policy

Product-owner questions must use geoscience and authoring language. Ask only about:

- the geological workflow the user is trying to complete;
- the actions the user takes on the canvas, tools, or files;
- the visible feedback the user should see;
- when the user must preview or confirm.

Do not ask the product owner to choose databases, leases, caches, transactions, merge algorithms, lock tokens, TTL values, or other implementation mechanics. Those belong in engineering notes and may be decided internally.

#### D-026: After Copy From, switch to Difference of the copied group

- Status: Confirmed by the product owner.
- Trigger: Confirm Copy succeeds. The new From 100 Ma group is added and selected as in D-025.
- Canvas: Automatically activate the existing Difference view.
- Meaning: Difference is the current 90 Ma map before versus after that newly added group. It is not a 100 Ma versus 90 Ma comparison.
- Layers: The copied group stays selected.
- Cue: Show a concise cue such as `正在查看 From 100 Ma 带来的变化 / Showing changes from From 100 Ma`.
- Continue: The user can immediately switch to After, Before, or Split View with the existing view controls.
- Hide, delete, undo: Hiding the group updates the cue. Deleting or undoing the group removes the copied-group cue.
- Prototype: Labeled simulation using the existing Difference buttons. The 90 Ma raster is not loaded. Difference does not claim a live 90 Ma raster.

#### D-027: Copy From defaults to the previous age and allows another earlier age

- Status: Confirmed by the product owner.
- Default: When Copy From opens, the source is the immediately previous available age. Example: 80 Ma opens with 90 Ma selected. 90 Ma opens with 100 Ma selected.
- Choice: The Source age control lists every earlier age. It never lists the current age or a later age. Example: 80 Ma can pick 90 Ma or 100 Ma, not 80 Ma.
- Live update: Changing the source immediately updates the source label, preview, result wording, and the group name that Confirm Copy will add, such as `来自 90 Ma / From 90 Ma` or `来自 100 Ma / From 100 Ma`.
- Reset: Closing and reopening Copy From restores the default previous age. It does not reuse the last override.
- Confirm: Confirm Copy still adds a new group for the chosen source, keeps existing target-age work, and follows D-024 through D-026. History records the chosen source and target.
- Prototype: Labeled simulation with 100 Ma, 90 Ma, and 80 Ma. 90 Ma and 80 Ma rasters are not loaded.

#### D-028: Copy From may use any earlier age, including drafts

- Status: Confirmed by the product owner.
- Availability: Any existing earlier age can be a Copy From source, including a draft. Example: in 80 Ma, the source list includes draft 90 Ma and finished 100 Ma.
- Default: D-027 still applies. Copy From defaults to the nearest previous age even if that age is a draft. Example: 80 Ma opens on 90 Ma Draft. The user may switch to 100 Ma Finished.
- Status as information: Source options show status such as `90 Ma · Draft` and `100 Ma · Finished`. Preview, History, and the copied group may repeat that status for provenance. Status is not an error and does not change Confirm Copy.
- No extra gate: A draft source is not disabled, blocked, or given a second warning or confirmation. The ordinary Confirm Copy is enough.
- Independence: After copy, the target-age group is an independent copy, as in D-023. The source age is unchanged.
- Acceptance: On 80 Ma, Copy From lists 90 Ma Draft and 100 Ma Finished, defaults to selectable 90 Ma Draft with Confirm enabled, records the source status after copy, and still allows finished 100 Ma.
- Prototype: Labeled simulation. 90 Ma is Draft and 100 Ma is Finished. On 80 Ma, Confirm Copy is enabled on the default draft 90 Ma with no extra warning. Switching to finished 100 Ma still works.

#### D-029: Copied groups stay unchanged when the source later changes, with an informational update cue

- Status: Confirmed by the product owner.
- Independence: After Copy From, the target-age group is an independent snapshot. Later edits to the source age never alter or overwrite that group automatically.
- Cue: If the source has newer changes, the copied group shows `来源已有更新 / Source has newer changes`. This is informational, not an error, and does not block editing or export.
- Review: The group offers `查看更新 / Review update`. Opening it shows the current target age, the originally copied source version and status, the latest source state, and a concise change preview. Reviewing does not change the target age, does not add a pending project edit, and does not clear the badge.
- No automatic refresh: Detecting or reviewing a source update never refreshes the copied group. Bring in update follows D-030.
- No cue when unchanged: Groups whose source has no newer changes show no update badge.
- Acceptance: After 80 Ma copies from draft 90 Ma, a later 90 Ma change leaves the From 90 Ma group content unchanged, shows Source has newer changes, and Review update does not mutate 80 Ma. A From 100 Ma group without newer source changes has no badge.
- Prototype: Labeled simulation. Simulate 90 Ma source change marks only groups copied from 90 Ma. Review update does not mutate. Bring in update follows D-030.

#### D-030: Bring in update adds a second Latest comparison group

- Status: Confirmed by the product owner.
- Action: After Review update, `引入更新 / Bring in update` is enabled. One click keeps the existing copied group and adds the latest source state as a second selected group above it.
- Naming: The new group is named `来自 90 Ma · 最新 / From 90 Ma · Latest` and records the latest source version and status. The original group is marked `旧副本 / Previous copy` and no longer shows an actionable Source has newer changes badge. The Latest group has no update badge.
- Existing work: Existing 80 Ma work stays below both groups and is unchanged.
- Difference: After Bring in update, Difference focuses the Latest group's contribution relative to the previous copy in the current 80 Ma context. This is a labeled demo, not a live raster.
- Undo: One Undo removes the Latest group and restores the original group's Source has newer changes cue. Redo restores Latest.
- History: One Bring in update is one pending edit and one History action. Opening Review update remains non-mutating.
- Acceptance: On 80 Ma, after reviewing a newer 90 Ma source, Bring in update adds From 90 Ma · Latest above the unchanged Previous copy, selects Latest, switches to Difference of that comparison, and leaves existing 80 Ma work in place. Undo removes only Latest and restores the source-update cue.
- Prototype: Labeled simulation using revision 1 versus revision 2 Coastline moved east. No 80 Ma or 90 Ma raster is loaded.

#### D-031: Explicit Use Latest and Keep Current finish the comparison

- Status: Confirmed by the product owner.
- Trigger: After Bring in update, 80 Ma shows both Previous copy and Latest. The comparison stays open until the user chooses. Nothing finalizes automatically.
- Actions: The workbench shows `采用最新 / Use Latest` and `保留当前 / Keep Current`.
- Use Latest: Keep Latest, remove Previous from the active layer stack, and convert Latest into the ordinary `来自 90 Ma / From 90 Ma` group. Keep revision 2 provenance. Existing 80 Ma work stays. This comparison's source-update state ends.
- Keep Current: Remove Latest, keep Previous as the ordinary `来自 90 Ma / From 90 Ma` group, and dismiss this reviewed source revision so `Source has newer changes` does not immediately return. Keep revision 1 provenance. Existing 80 Ma work stays.
- After either action: Return to After view with the kept group selected, close the comparison bar and Latest/Previous labels, and record one History / pending edit.
- Undo: One Undo restores the two-group comparison. Redo reapplies the chosen finish action.
- Later updates: A later source revision may show a new update cue. This reviewed revision does not come back by itself.
- Acceptance: On 80 Ma after Bring in update, Use Latest leaves one selected From 90 Ma group at revision 2 with existing 80 Ma work kept. Keep Current leaves one selected From 90 Ma group at revision 1, dismisses the revision 2 cue, and keeps existing 80 Ma work. Either action is one undoable History step.
- Prototype: Labeled simulation. No 80 Ma or 90 Ma raster is loaded.

#### D-032: Live Preview switch, on by default

- Status: Confirmed by the product owner.
- Scope: Point, line, and area terrain tools, including ridge, valley, lake, and the other terrain generators.
- Control: Tool properties show `实时预览 / Live Preview`. It is on by default. The user's on/off choice persists when switching among terrain tools.
- Live Preview on: After geometry is ready, finishing the geometry and changing valid terrain parameters (height/delta, width/radius, blend strength, seed, profile, mask, and NoData base) regenerates Preview automatically. The user does not need to click Preview for ordinary tweaks.
- Apply: Preview remains non-destructive. Apply stays explicit and is enabled only after a fresh valid preview.
- Range: If an automatic preview is outside `[-12000, 12000] m`, the range issue appears immediately and Apply stays disabled.
- Live Preview off: Parameter changes do not regenerate Preview. The form marks Preview as needing refresh and Apply stays disabled until the user clicks Preview. Manual Preview still works.
- Feedback: Automatic updates use the canvas and inline preview status. They do not toast on every keystroke. The parameter field keeps focus.
- Follow-up: Closed as D-033.
- Acceptance: With Live Preview on, placing a peak or finishing a ridge and then changing height or width updates Preview without clicking Preview, keeps the field focused, and enables Apply only for a valid result. Turning Live Preview off stops automatic updates; Apply stays disabled until Preview is clicked. Switching from ridge to lake keeps the same Live Preview setting.
- Prototype: Synthetic 96×54 raster. Automatic preview uses the existing Preview path and does not write the source NetCDF.

#### D-033: Keep the last Preview and mark it out of date

- Status: Confirmed by the product owner.
- Trigger: Live Preview is off. A valid Preview is already on the canvas. The user then changes terrain parameters (height/delta, width/radius, blend, seed, profile, mask, or NoData base) without clicking Preview.
- Canvas: Keep the last Preview visible as a visual reference. Do not hide it or return to the committed surface automatically.
- Label: Show `预览已过期 / Preview out of date` on the canvas and in Tool Properties. The status makes clear that the canvas still reflects the last Preview, while the current parameter inputs are not yet previewed.
- Apply: Stays disabled until the user clicks Preview or turns Live Preview back on and a fresh valid preview exists.
- Refresh: Manual Preview, or turning Live Preview on with ready geometry, replaces the old Preview, clears the out-of-date label, and enables Apply only if the new result is in range.
- Acceptance: After a 1200 m peak Preview, turning Live Preview off and changing height to 1800 m keeps the 1200 m Preview on the canvas, shows Preview out of date, distinguishes last-preview versus current parameters, and leaves Apply disabled. Clicking Preview or turning Live Preview on updates the canvas to 1800 m and clears the label.
- Prototype: Synthetic 96×54 raster. The leftover Preview is the last computed Preview array, not a second raster.

### Requirements Q&A status

Requirements Q&A is paused and closed for prototype convergence. D-001 through D-033 are confirmed. The HTML prototype is the primary artifact; this PRD is supporting documentation.

### Future backlog (non-blocking)

These are not numbered product questions:

- Ridge height and width as number-only fields versus slider plus numeric input.
- Whether Apply on an out-of-date Preview should ask for a second confirmation.
- How terrain Preview should relate to the Difference view.

### Data questions for technical discovery

- Exact downstream tools that consume the exported NetCDF-4 files.
- Whether any future workflow requires true polar-crossing geometry.
- Whether large NetCDF and `ΔE` blobs are stored in the database or a content-addressed object store.
- Write-lease TTL, heartbeat recovery, and server revalidation when a lease becomes uncertain.

## 17. Reference Interaction Sources

- Adobe Photoshop Magic Wand tool and selection operation modes:  
  <https://helpx.adobe.com/photoshop/using/tool-techniques/magic-wand-tool.html>
- Adobe Photoshop keyboard shortcut reference:  
  <https://helpx.adobe.com/photoshop/desktop/get-started/settings-and-preferences/view-keyboard-shortcuts.html>
- QGIS Processing Toolbox:  
  <https://docs.qgis.org/latest/en/docs/user_manual/processing/toolbox.html>
- QGIS expressions:  
  <https://docs.qgis.org/latest/en/docs/user_manual/expressions/expression.html>
- QGIS Select by Expression algorithm family:  
  <https://docs.qgis.org/latest/en/docs/user_manual/processing_algs/qgis/vectorselection.html>
- Google Maps polygon and shape interaction reference:  
  <https://developers.google.com/maps/documentation/javascript/shapes>

## 18. Prototype Mapping

The companion HTML prototype demonstrates:

- simultaneous Chinese-English UI labels;
- Photoshop-style tool rail and selection modifiers;
- QGIS-style Processing Toolbox;
- a synthetic raster canvas;
- Cell Select;
- Magic Wand;
- Quick Selection Brush;
- Polygon Select;
- Select by Expression;
- Direct Value Editing;
- Undo and Redo;
- the confirmed non-destructive Edit Layer structure;
- the confirmed Blend Seam terminology and smoothing behavior;
- the confirmed one-NetCDF-per-age series model;
- the confirmed regular longitude-latitude grid and kilometer-based geometry model;
- automatic normalization and source-preserving export for both longitude conventions;
- the confirmed positive-up elevation semantics with sea level at zero;
- selectable and editable NoData behavior with explicit relative-operation base values;
- the confirmed `3600 × 1800` maximum and tile-delta browser memory model;
- the confirmed Float32 meter storage and one-time rounding contract;
- automatic normalization and source-preserving export for NaN and finite NoData sentinels;
- fixed `[-12000, 12000] m` validation with blocking Apply and Export;
- user-confirmed, CF-recommended elevation variable mapping persisted for the PaleoDEM Series;
- configurable export storage layout with source preservation as the default;
- NetCDF-4 / HDF5 as the only accepted and exported container;
- cyclic date-line behavior with bounded, non-crossable polar edges;
- relative-delta-only terrain generation with `E_new = E_base + ΔE`;
- ordered sequential Edit-Layer composition with the source at the bottom and last-evaluated layers on top;
- stale derived `ΔE` layers that keep their cache, warn conspicuously, block export while enabled, and require explicit recompute;
- explicit cascade recompute of the selected stale derived layer and every enabled affected upper derived layer, labeled as a dependency-state demo rather than live raster evaluation;
- atomic all-or-nothing cascade commit, with a labeled Coastline 03 failure simulation that discards staged `ΔE` tiles and restores the pre-action stale state;
- a local `.pdemproj` plus cloud-database sync simulation: committed edits enqueue an outbox, failed cascades do not, and Sync now acknowledges records in order without a backend;
- a single-writer lease simulation: this device can edit and sync; another-writer lease makes the client read-only, preserves the pending outbox, and does not claim a real lock backend. This remains an engineering demo, not the open product question;
- target-side Copy From Previous Age: the user enters a 90 Ma time-slice context, then explicitly opens Copy From. The preview names 90 Ma as the current target and 100 Ma as the source. The dialog offers entire previous age as the default and selected content with a Coastline, Ridge, and Basins / Edit Layers checklist. Confirm is enabled when the scope is valid. One Confirm Copy records a grouped independent-copy result in History and the pending outbox. The 90 Ma raster is not loaded. Terrain Apply has no target-age checkboxes and does not copy into other ages;
- Copy From adds, never replaces: 90 Ma already shows existing work such as a 90 Ma coastline. Confirm Copy inserts a selected `来自 100 Ma / From 100 Ma` group above that work. The group can be shown, hidden, or deleted as one unit. Undo Copy From removes the whole group. Confirmation text says existing 90 Ma work was kept. Move is labeled as not implemented;
- after Confirm Copy, the existing Difference view is selected. A concise cue names the copied group's contribution to current 90 Ma before versus after that group, not a 100 versus 90 comparison. The user can switch to After, Before, or Split View. Hiding, deleting, or undoing the group updates or removes the cue. This is a labeled demo; the 90 Ma raster is not loaded;
- Copy From source age: 100 Ma, 90 Ma, and 80 Ma are available as demo slices. On 80 Ma, Copy From defaults to 90 Ma and lists 90 Ma and 100 Ma, never 80 Ma or a later age. The user can switch to 100 Ma; preview, result wording, group name, and History follow the chosen source. Closing and reopening restores 90 Ma. On 90 Ma, the default remains 100 Ma;
- Copy From draft sources: 90 Ma is Draft and 100 Ma is Finished. Any earlier age, including a draft, can be copied directly. On 80 Ma, Copy From defaults to selectable 90 Ma Draft with Confirm enabled and no extra warning or confirmation. Source status appears in the source list, preview, History, and copied-group summary as information only. Finished 100 Ma remains selectable;
- copied groups stay independent when the source later changes: after 80 Ma copies from draft 90 Ma, simulating a later 90 Ma change leaves the From 90 Ma group content unchanged, shows `Source has newer changes`, and Review update does not mutate 80 Ma or add a pending edit. A From 100 Ma group with no newer source changes shows no badge;
- Bring in update adds a second comparison group: after Review update, one Bring in update keeps the original From 90 Ma group as Previous copy and adds a selected `From 90 Ma · Latest` group above it. Existing 80 Ma work stays below both. Difference focuses Latest versus the previous copy in current 80 Ma, labeled as a demo. One Undo removes Latest and restores the source-update cue. Reviewing remains non-mutating; Bring in update is one History action;
- comparison finish is explicit: after Bring in update, Use Latest and Keep Current are shown and nothing finalizes automatically. Use Latest keeps Latest as an ordinary From 90 Ma group at revision 2 and removes Previous. Keep Current removes Latest, keeps the original From 90 Ma group at revision 1, and dismisses this reviewed update so the cue does not immediately return. Either action returns to After view, keeps existing 80 Ma work, and is one undoable History / pending edit;
- terrain tools keep a Live Preview switch, on by default. With it on, finishing geometry and changing valid height, width, blend, seed, profile, mask, or NoData base regenerates Preview without clicking Preview. Apply stays explicit and is enabled only after a fresh valid preview. Out-of-range automatic previews show the range issue immediately and keep Apply disabled. With Live Preview off, parameter changes do not regenerate Preview; Apply stays disabled until the user clicks Preview. The on/off choice persists across terrain tools. Automatic updates use inline status and the canvas, not a toast on every keystroke, and keep parameter focus;
- when Live Preview is off and parameters change after a Preview, the last Preview stays on the canvas and is labeled `预览已过期 / Preview out of date`. The properties note distinguishes the last previewed values from the current inputs. Apply stays disabled until Preview or Live Preview refreshes the result;
- the left tool rail stays icon-only. Pointer enter or keyboard focus waits 100 ms, then a body-level overlay shows the bilingual tool name to the right of the icon. Leaving before 100 ms cancels it; leaving, blur, Escape, or pointerdown hides it. Native `title` tooltips are not used on tool buttons.

The prototype is an interactive HTML workbench, not a replacement for the Canonical TimeMachineWeb UI. Requirements Q&A is paused; the product surface does not present open questions or decision counts.

### 18.1 v0.37 UI implementation boundaries

The minimal workbench retains the existing synthetic 96×54 raster and numerical algorithms. Source mapping controls still address the same synthetic array; export validates settings but writes no NetCDF file. Entering 90 Ma or 80 Ma is a document-context switch only and does not load those rasters. Copy From Previous Age is a labeled simulation: entire previous age is the default, selected content requires at least one item, and Confirm Copy adds a From <source> group above existing target-age work without replacing it, then switches to the existing Difference view and labels that group's contribution. On 80 Ma, Copy From defaults to 90 Ma Draft and can switch to 100 Ma Finished; reopening restores 90 Ma. Draft sources are selectable with no extra warning. On 90 Ma, the default remains 100 Ma Finished. Simulate 90 Ma source change marks only groups copied from 90 Ma with an informational Source has newer changes badge; Review update does not mutate 80 Ma. Bring in update adds From 90 Ma · Latest above the unchanged Previous copy, selects Latest, and focuses Difference on that comparison; Undo removes Latest and restores the cue. After Bring in update, Use Latest and Keep Current finish the comparison without auto-replacing. Use Latest keeps Latest as From 90 Ma at revision 2 and removes Previous. Keep Current removes Latest, keeps revision 1, and dismisses this reviewed cue. Either action returns to After view and is one History step. The copied group visibility toggle and deletion are simulated in the Layers panel; move is shown as not implemented. Point, line and area terrain tools show Live Preview, on by default. With it on, finishing geometry and changing valid terrain parameters regenerates Preview without a Preview click; Apply stays disabled until that preview is valid. With it off, parameter changes keep the last Preview on the canvas, label it `预览已过期 / Preview out of date`, distinguish last-preview versus current parameters, and leave Apply disabled until Preview is clicked or Live Preview is turned on. Left-rail tool names appear in a fixed overlay 100 ms after pointer enter or focus, without changing rail width or using native `title` tooltips. Help opens a Prototype Guide for the four main user flows. Serial decision dialogs, open-question badges, and decision-count labels are not shown in the product UI. Engineering demo controls (Arm Coastline failure, other-writer lease, lower-layer change, 90 Ma source change) sit in a collapsed Demo scenarios disclosure. Worker/tile-delta storage, real file I/O, real age-raster switching, pan/zoom, true layer reordering and the full sequential replay architecture are not implemented or performance-validated. Unsupported controls are disabled rather than presented as working features.

### 18.2 Current prototype user flows

1. **Select and edit.** Use Cell Select, Magic Wand, Quick Selection Brush, Polygon Select, or Select by Expression. Then Direct Value Editing to Set Value or Add Offset, and Apply.
2. **Draw terrain.** Choose a point, line, or area tool, draw geometry, and inspect Live Preview (on by default) or click Preview. Apply commits to Edit Layer 01. If Live Preview is off, changing parameters keeps the last Preview, marks Preview out of date, and leaves Apply disabled until Preview or Live Preview refreshes it.
3. **Copy From Previous Age.** Enter a later age, open Copy From, confirm entire or selected content, then review Difference of the new group. Source updates stay independent until Use Latest or Keep Current.
4. **Review Layers, History, Difference, and sync.** Inspect composition and stale recompute in Layers, undo/redo in History, compare with Difference, and watch the header sync status.

UI changes are limited to `prototypes/paleodem-editor/` and this PRD. No changes are made to the production Vue application or Canonical UI. Focused DOM/event regression tests run with:

```sh
node --test prototypes/paleodem-editor/workbench.test.mjs
```

Native focus, pointer gestures, layout and screenshots require separate real-browser validation; the DOM tests do not prove visual correctness.

## 19. Current change record — Landform / Quick Selection / Terrain Tools / Terra Antiqua

**Status: user-approved increment, pending implementation and validation.** This is a documentation-stage record, not a new numbered D decision or a claim that the prototype or tests already implement it. Sections 1–18 and D-001–D-033 above remain historical, including their old Wand / Quick descriptions and test expectations. For the current contract, read:

- [English functional PRD](./paleodem-editor-functional-prd.md) — authoritative behavior and new acceptance criteria.
- [Chinese functional PRD](./paleodem-editor-functional-prd.zh-CN.md) — matching Chinese specification.
- [Terra Antiqua Chinese research / adoption report](./paleodem-terra-antiqua-research.zh-CN.md) — all 4 primary + 9 secondary tools, workflow, official sources / version limits, formula discrepancies, and adopt-now / later matrix.

Approved changes superseding earlier descriptions:

1. Replace tolerance Magic Wand with actual **Landform Select**: Mountains by relative relief / prominence, Valleys by local trough / concavity, Coastlines by a narrow connected valid land–sea boundary band. Use the committed current DEM, bounded deterministic heuristics, no-match feedback, and manual boundary correction; do not claim scientific / AI accuracy.
2. Quick paints full footprint unions across any elevation and NoData, including interpolated sparse strokes and shortest date-line wrap. It has independent **New / Add / Subtract only**, first-use Add preserving the mask, and one-shot New→Add. Generic Cell / Landform / Polygon keep four modes. Shift Add / Alt Subtract remain PS-standard; Ctrl/Cmd Add remains a compatibility extension; Quick combined chords with Alt Subtract, never Intersect. Locked gestures and visible feedback agree.
3. Put **Deselect / Inverse at the actual far left**, before current tool / mode controls. Rename toolbox-related UI to **地形工具 / Terrain Tools**, grouped by user task with geological entry / active-tool names and stable existing code IDs. Preserve the dense 46 px rail and 100 ms bilingual tooltips. The existing line Coastline is accurately named **Coastal Uplift / Lowering**, not true Set Paleoshorelines.
4. Add only **Regional Rescale, Fill NoData (fixed / bounded deterministic IDW), Regional Smooth, and Sea-level Shift** to the existing Preview → inspect → explicit Apply → Undo/Redo / audit flow. Regional scope defaults to Current Selection and blocks when empty; Whole DEM is explicit, with a visible whole-scope default for sea level. Positive sea-level rise subtracts from E. Finite transformations derive ΔE; fill records explicit validity / finite-base semantics rather than subtracting NaN. Detailed flat-rescale rejection, frozen local donors, atomic missing-donor rejection, and sign-protected smoothing are implementation-owner-confirmed prototype boundaries, not asserted scientific models.
5. Multi-source compile, true polygon-constrained paleoshorelines, age-depth bathymetry, and ice compensation remain future, data-dependent capabilities; no placebo execution buttons or GPL source copying. Source-readonly, Float32 range, NoData, longitude / polar boundaries, retained stale Preview, target-initiated Copy From, write lease, and cloud outbox semantics remain unchanged.

No application or prototype implementation was performed by this documentation stage. Prior handoff test counts do not validate this increment; implementation must update only superseded assertions, retain regression coverage, and provide exact node / project build-test / real-browser evidence before marking it complete. The operational handoff is intentionally retained as the prior verified baseline until that later validation.

**Implemented-note (prototype complete for this approved scope).** The documentation-stage text above is unchanged history. The prototype now implements Landform signed residual (planar ramps rejected), scoped preview refresh/stale on Inverse/Deselect, invalid numeric/radius blocking without silent clamp, Quick New consumed even when unchanged, structured scoped Apply audit records, and no-op unchanged DEM commits. See the functional PRDs and handoff for algorithms, records, and final test counts.
