# PaleoDEM Editor — Functional PRD

Language / 语言: English (authoritative) · [简体中文](./paleodem-editor-functional-prd.zh-CN.md)

> Authoritative feature specification for the Paleogeographic Map Authoring Module (UI name: **PaleoDEM Editor**).  
> Decision/history record: [`paleodem-editor-prd.md`](./paleodem-editor-prd.md) (D-001–D-033).  
> Operational handoff: [`paleodem-editor-handoff.md`](./paleodem-editor-handoff.md).  
> Canonical UI impact: none. Do not change `docs/ui-reference/canonical/index.html`.  
> Terra Antiqua research and adoption boundary: [Chinese research report](./paleodem-terra-antiqua-research.zh-CN.md).

**Increment status — prototype implementation validated (this run).** Landform Select, Quick footprint union / three-mode behavior, far-left selection actions, named Terrain Tools, and the four bounded DEM operations are implemented in `prototypes/paleodem-editor` and covered by the §14 evidence below. Documentation-stage text previously marked these items **approved pending implementation**; that historical status is superseded only for the implemented prototype increment, not rewritten as if it had already shipped. Unchanged features retain their contracts. Historical D-001–D-033 remain recorded without rewriting them. Independent parent browser verification is complete; this is prototype acceptance, not geological validation.

## 1. Product goal and non-goals

**Goal.** Let a geoscientist select PaleoDEM grid cells, edit values, and generate terrain on a regular lon/lat raster with Photoshop-like selection and QGIS-like parameters, while keeping the source NetCDF read-only and every commit previewable, undoable, and auditable.

**Non-goals (first release / this prototype).**

- General-purpose vector GIS or Photoshop compositing.
- Editing more than one variable, or loading more than one age raster on the same canvas.
- Topology-aware plate reconstruction.
- Collaborative multi-user editing.
- Replacing the TimeMachineWeb 3D globe.
- Real NetCDF I/O, Worker/tile-delta performance, pan/zoom, or live multi-age rasters in the HTML prototype.
- Multi-source compile, true polygon-constrained Set Paleoshorelines, age-depth bathymetry, or ice-load compensation in this increment; these need external data and scientific review.
- Porting Terra Antiqua / QGIS, copying its GPL-3.0-or-later source, or claiming Photoshop image segmentation or scientific / AI accuracy for synthetic DEM heuristics.

## 2. Users and personas

| Persona | Need |
| --- | --- |
| Paleogeographer / geoscientist | Select cells and express ridges, valleys, lakes, and coastlines without writing Python. |
| Technical reviewer | Inspect parameters, compare Before/After/Difference, and reproduce an export. |

## 3. Prerequisites

- Desktop viewport (≥1000 px; targets 1440×900, 1280×800, 1024×768).
- One PaleoDEM age file: NetCDF-4 / HDF5, regular `elevation(lat, lon)`, Float32 meters, inclusive range `[-12000, 12000] m`.
- User-confirmed elevation variable mapping (`E` aliases the source name).
- Longitude convention `[-180°, 180°)` or `[0°, 360°)`; geometry is canonical `[-180°, 180°)`.
- Prototype: synthetic 96×54 raster. No real file is opened or written.

## 4. Input / output contracts

| Contract | Rule |
| --- | --- |
| Input container | NetCDF-4 / HDF5 only. NetCDF-3 is rejected before parse. |
| Grid | Regular lon/lat; source `row`/`col` is cell identity. |
| Elevation | Positive-up; `E=0` is sea level. |
| NoData | Editable. NaN and finite `_FillValue` / `missing_value` are both NoData. |
| Terrain | Stores relative `ΔE`; `E_new = E_base + ΔE`. Finite result transforms derive `ΔE = result − E_base`; NoData fill needs an explicit finite base and validity transition, never subtraction from NaN (§7.8.2). |
| Composition | Read-only source + ordered Edit Layers + selection mask. |
| Export | New NetCDF copy; source is never silently overwritten. Prototype validates settings only. |
| Project | Local `.pdemproj` snapshot + cloud change records. Prototype simulates both. |

## 5. Glossary

| Term | Meaning |
| --- | --- |
| Cell | One raster grid cell (`row`, `col`). |
| Selection | First-class mask. Generic selection: New / Add / Subtract / Intersect; Quick: New / Add / Subtract only. |
| Persistent mode | Remembered toolbar mode; Quick keeps independent state and returns from one-shot New to Add after the stroke. |
| Transient mode | Modifier overlay; it does not rewrite persistent mode. A locked gesture keeps its pointer-down mode. |
| Landform candidate | Connected DEM-feature mask inferred from the committed current surface, not a tolerance-matched elevation island. |
| Brush footprint union | All cells covered by Quick brush stamps, including any elevation and NoData; not similarity growth. |
| Live Preview | Automatic non-destructive terrain preview; Apply remains explicit. |
| Copy From Previous Age | Target-age pull from an earlier age; Apply never pushes to other ages. |
| Write lease | At most one cloud writer. Uncertain lease → project-changing actions are read-only. |

Do not translate variable names, units, CRS IDs, or algorithm IDs (`E`, `lon`, `source_lon`, `m`, `km`, `EPSG:4326`, `NetCDF-4`, `ΔE`).

## 6. Feature inventory

1. Dataset / age / variable / longitude settings.
2. Selection tools: Cell Select, Landform Select (Mountains / Valleys / Coastlines), Quick Selection Brush, Polygon Select, Select by Expression.
3. Generic four-mode selection, independent Quick three-mode selection, transient modifiers, and far-left Deselect / Inverse.
4. Direct Value Editing (`Set Value`, `Add Offset`).
5. Named Terrain Tools: existing Peak, Ridge, Valley, Canyon, Barrier, Blend Seam, Coastal Uplift / Lowering, Lake Basin, Mountain Region; new Regional Rescale, Fill NoData, Regional Smooth, Sea-level Shift.
6. Live Preview and Apply.
7. Layers, History, Difference / Before / After / Split View.
8. Copy From Previous Age.
9. Export validation.
10. Cloud sync and write-lease simulation.

## 7. Feature definitions

Each feature lists purpose, entry, preconditions, behavior, visible feedback, result, and exceptions.

### 7.1 Selection operation modes

- **Purpose.** Combine a candidate mask with the current selection using PS-style controls, with the explicitly retained PaleoDEM Ctrl/Cmd compatibility extension.
- **Entry.** Contextual options-bar mode buttons or held modifiers while a pointer selection tool is active.
- **Preconditions.** Cell Select, Landform Select, Polygon Select, or Quick Selection Brush is active. Select by Expression uses the generic persistent mode on Select, not pointer modifiers.
- **Behavior.** Cell / Landform / Polygon and expression selection retain New / Add / Subtract / Intersect. Quick exposes **New / Add / Subtract only**, with independent remembered state (§7.4). Outside an already locked gesture, modifiers override the persistent mode:

  | Held keys | Cell / Landform / Polygon | Quick |
  | --- | --- | --- |
  | Ctrl/Cmd **or** Shift, without Alt | Add | Add |
  | Alt/Option | Subtract | Subtract |
  | Ctrl/Cmd+Alt **or** Shift+Alt | Intersect | Subtract — Alt wins; no hidden Intersect |
  | none | Generic persistent mode | Quick persistent mode |

  Adobe documents Shift Add and Alt/Option Subtract; Ctrl/Cmd Add is a product extension, not PS standard. The combined-key Intersect extension never applies to Quick. See [§12](#12-adobe-citations).
- **Visible feedback.** `is-active` / `aria-pressed="true"` shows the actual effective mode, including a gesture's locked mode even if keys change mid-stroke. Key release, window blur, and tool change clear transient state; when no locked gesture is active, the relevant remembered mode is restored. Switching between Quick and generic tools must not overwrite either remembered mode. Names and modifier hints are compact, bilingual, Chinese first.
- **Result.** Mask combination is undoable; only a changed mask creates a selection History command. Modifiers do not rewrite persistent state.
- **Exceptions.** Text fields and open dialogs do not trigger document shortcuts or selection overlays; keyup may still clear stale state. Suppress the context menu only on the editing canvas while a selection tool is active, not across the document. macOS Ctrl-click still Adds, except Quick with Alt held Subtracts.

### 7.2 Cell Select

- **Purpose.** Select one cell, including NoData.
- **Entry.** Tool rail Cell Select (`C`) and click the canvas.
- **Preconditions.** Tool is active.
- **Behavior.** Click selects that cell using the effective mode. Status reports row, col, lon/lat, and `E`.
- **Visible feedback.** High-contrast overlay; status bar; History `单网格选择 / Cell Select`.
- **Result.** One-cell candidate combined with the current mask.
- **Exceptions.** Non-primary buttons are ignored except macOS Ctrl-click (button 2) which still Adds.

### 7.3 地貌选取 / Landform Select

- **Purpose.** Select an existing landform boundary candidate from DEM features. This replaces the tolerance Wand behavior, not just its label.
- **Entry.** Tool rail Landform Select (`W` cycles with Quick Selection); choose 山脉 / Mountains, 沟谷 / Valleys, or 海岸线 / Coastlines, then click.
- **Preconditions.** Use the **committed current DEM**, including applied edits, never an unapplied Preview or only the immutable source. Expose or document bounded neighborhood / sensitivity and connectivity; grid-scale settings say `cells`, not `km`.
- **Behavior.** Deterministically derive qualifying cells and return the connected candidate at the clicked feature, then combine using §7.1:

  | Class | Required distinguishing evidence | Must not be substituted with |
  | --- | --- | --- |
  | Mountains | Local relative relief plus a **positive** signed center-versus-neighborhood residual above a positive threshold | All high cells, a high flat plateau interior, or a tilted planar gradient |
  | Valleys | Local relative relief plus a **negative** signed center-versus-neighborhood residual below −threshold | All low cells, an undifferentiated deep ocean, or a tilted planar gradient |
  | Coastlines | Narrow connected band along adjacent valid land / sea cells, with explicit zero-height boundary handling | All ocean, interior land, or a NoData edge treated as a coast |

  Neighbors wrap longitude and clip at polar rows. Do not select every disconnected qualifying feature at once. Shift / Ctrl/Cmd can add another candidate; Alt/Option removes the clicked candidate. Quick Add / Subtract manually corrects uncertain boundaries.
- **Visible feedback.** Active class name, heuristic / synthetic-data limitation, candidate / selected counts, and `未找到匹配地貌 / No matching landform` when appropriate; no scientific or AI-accuracy claim.
- **Result.** One History entry per click that changes the mask; no DEM edit. Same committed input and settings produce the same candidate.
- **Exceptions.** No qualifying candidate or a NoData click preserves the existing mask, even in New mode, with no History. NoData remains selectable and editable via Cell / Quick / Polygon / expressions. Unchanged combinations report `选区未发生变化 / Selection did not change`. This is neither terrain generation nor a true paleoshoreline constraint.

### 7.4 Quick Selection Brush

- **Purpose.** Paint the exact union of brush footprints, including arbitrary elevations and NoData, to build or correct a selection.
- **Entry.** Quick Selection Brush (`W` cycle); click or drag. `[` / `]` change Size; remove Tolerance / seed / similarity controls.
- **Preconditions.** Size is valid. Quick has its own remembered New / Add / Subtract state, independent from generic four-mode tools. **First use defaults to Add and preserves any existing mask.**
- **Behavior.** Each stamp includes all cells in its footprint. Interpolate stamps between sparse pointer moves so strokes have no gaps; use the shortest date-line wrap and clip polar rows. With Add, two clicks / strokes produce `S_new = S_old ∪ footprint_1 ∪ footprint_2`, not a replacement on the second click. Subtract removes only painted cells. Explicit New replaces with one complete stroke's footprint, then returns to Add; an Add / Subtract modifier does not erase the old mask first. No hidden Intersect is allowed.
- **Visible feedback.** Brush cursor radius and live mask overlay; toolbar shows the **effective mode locked at pointer-down for the entire stroke**, even if keys change during the drag. After completion it shows the applicable transient / remembered mode; releasing keys restores remembered state.
- **Result.** A changed completed stroke is one History entry, not one per stamp; Undo/Redo restore its whole mask change. Quick's remembered mode survives switching away and back without changing generic state.
- **Exceptions.** Empty / unchanged strokes do not write History. Combined modifier chords with Alt always Subtract in Quick. This footprint-union rule is the user's DEM adaptation, not Photoshop's image-edge segmentation algorithm (§12).

### 7.5 Polygon Select

- **Purpose.** Select cells whose centers lie inside a polygon.
- **Entry.** Polygon Select (`L`); click vertices; Enter / double-click finish; Backspace removes last vertex; Esc cancels.
- **Preconditions.** At least three vertices to finish.
- **Behavior.** First vertex locks the effective mode for that polygon. Longitude unwraps near `±180°`. Space-to-pan is specified for product; prototype pan is not implemented.
- **Visible feedback.** Preview edges; vertex count.
- **Result.** One History entry on finish.
- **Exceptions.** Fewer than three vertices toasts and does not select.

### 7.6 Select by Expression

- **Purpose.** QGIS-style boolean selection.
- **Entry.** Expression tool (`F`) or 地形工具 / Terrain Tools.
- **Preconditions.** Fields `E` / mapped variable, `lon`, `source_lon`, `lat`, `row`, `col`, `is_nodata`.
- **Behavior.** Validate then Select. Uses the generic persistent toolbar mode (not Quick state or pointer modifiers).
- **Visible feedback.** Syntax status, count preview, errors.
- **Result.** Mask replace/combine per persistent mode.
- **Exceptions.** Invalid expression does not change the mask.

### 7.7 Direct Value Editing

- **Purpose.** Set or offset selected cell values.
- **Entry.** Values tool (`E`) after a non-empty selection.
- **Preconditions.** Write lease held. Selection count > 0. Result in `[-12000, 12000] m`.
- **Behavior.** `Set Value` fills NoData. `Add Offset` uses the declared NoData base strategy (prototype: local valid-neighbor mean). Preview/apply shows counts and statistics.
- **Visible feedback.** Affected count; toast on block; Edit Layer 01 operation count.
- **Result.** One undoable edit; pending cloud outbox entry.
- **Exceptions.** Out-of-range or read-only lease: no History, no layer write.

### 7.8 Terrain Tools and existing terrain generation

- **Purpose.** Keep existing geometry-driven terrain functional, organized by geological task rather than anonymous point / line / area controls. Naming / organization changes are implemented in the prototype toolbox.
- **Entry.** Peak (`P`), the named active linear feature (`G`), the named active area feature (`A`), or 地形工具 / Terrain Tools. Geometry remains a parameter / tool family; active names and tooltips identify the actual geological operation.
- **Preconditions.** Geometry ready for generators (point; ≥2 line vertices; ≥3 area vertices). Write lease for Apply. The four scoped DEM operations in §7.8.2 do not require drawing geometry.
- **Behavior.** Existing flow: draw → parameters → Preview → inspect → Apply to **current age only**. Keep Peak; Ridge / Valley / Canyon / Barrier / Blend Seam; Lake Basin / Mountain Region. The existing line-based Coastline operation is accurately named **海岸抬升 / 降低 / Coastal Uplift / Lowering**: local relative elevation adjustment near a line, **not** polygon-defined Set Paleoshorelines. Existing geometry widths / radii stay latitude-aware kilometers; new grid neighborhoods must explicitly use `cells` when applicable.
- **Visible feedback.** Geological name, preview statistics, range warning, After/Before/Difference/Split. Existing algorithm code IDs stay stable despite display-name changes.
- **Result.** `E_new = E_base + ΔE` on Edit Layer 01; one History command. No propagation to other ages.
- **Exceptions.** Invalid geometry / parameters, out-of-range or stale Preview, or read-only lease disable Apply without History.

#### 7.8.1 Named Terrain Tools catalog

Replace all current **toolbox-related** Algorithms / Processing / Tools labels with **地形工具 / Terrain Tools**: tab, search label / placeholder, menu, headers, empty results, and help. Do not mechanically rename unrelated Tool properties. Keep compact bilingual entries, searchable Chinese / English geological names, expansion / reset behavior, and existing stable algorithm IDs. New operations receive stable versioned IDs during implementation; do not invent a data migration for a text rename.

| User task group | Named entries / existing inspection access |
| --- | --- |
| 选定 / 定义区域 / Select / Define Region | 单网格选择 / Cell Select; 地貌选取 / Landform Select; 快速选择 / Quick Selection; 多边形选择 / Polygon Select; 按表达式选择 / Select by Expression |
| 修改既有地形 / Modify Existing Relief | 设置数值 / Set Value; 叠加偏移 / Add Offset; 区域重缩放 / Regional Rescale; 海岸抬升 / 降低 / Coastal Uplift / Lowering; 海平面升降 / Sea-level Shift |
| 生成缺失地貌 / Generate Missing Features | 山峰 / Peak; 山脊 / Ridge; 山谷 / Valley; 峡谷 / Canyon; 屏障 / Barrier; 湖盆 / Lake Basin; 山地区域 / Mountain Region |
| 修复 / 检查 / Repair / Check | 空洞填补 / Fill NoData; 区域平滑 / Regional Smooth; 接缝融合 / Blend Seam; existing Difference / statistics / range checks, not a new technical test panel |

Show a concise optional guide: define region → modify usable relief → generate only missing features → repair / inspect. No forced wizard, landing-page / card redesign, or placebo buttons for multi-source compile, true Set Paleoshorelines, age-depth bathymetry, or ice compensation. The [research report](./paleodem-terra-antiqua-research.zh-CN.md) explains all 13 Terra Antiqua tools, source conflicts, and now / later dependencies.

#### 7.8.2 Four bounded DEM operations

**Shared contract.** Input is the committed current synthetic DEM, not source-only values or an unapplied Preview. Regional tools default to **当前选区 / Current Selection**; an empty selected scope blocks, never silently falls back to the whole raster. **整个 DEM / Whole DEM** is explicit opt-in for regional tools; Sea-level Shift defaults to visibly selected Whole DEM and can explicitly use Current Selection. Scope / selected-target counts remain visible before Apply. No eligible or changed target gives feedback without History / outbox mutation.

The following numerical boundaries are **implementation-owner-confirmed prototype contracts, not user-approved scientific models**. Bounded radii, IDW weights, and classifier sensitivities must be fixed / constrained and documented in help, operation parameters, and tests. Grid distances / radii say `cells`, not `km`; physical-scale treatment and scientific validation remain future work.

| Operation | Inputs and deterministic result | Validation / limits |
| --- | --- | --- |
| Regional Rescale | Domain = valid scoped cells; source extrema `smin/smax`; finite target `a ≤ b`; `R = a + (E−smin) × (b−a)/(smax−smin)` | Target bounds and result in `[-12000,12000] m`. Flat source (`smin = smax`) blocks and points to Set Value. NoData unchanged; shoreline sign may change and must be inspected. |
| Fill NoData — Fixed Value | Finite target value; write that value only to scoped NoData | Valid cells and all out-of-scope cells unchanged; range check before commit. |
| Fill NoData — Interpolation | Independent bounded deterministic IDW: `R = Σ(w_i E_i)/Σw_i`, positive inverse-distance weights from valid local donors in a frozen pre-operation snapshot | May read local donors outside the write scope, never write outside it. Newly filled cells do not become donors. Any target without a donor blocks the entire operation, not partial fill. Document radius / distance / weights; no GDAL parity or large-basin reconstruction claim. |
| Regional Smooth | Bounded local uniform mean from the frozen pre-operation snapshot; only valid scoped targets are written; local read neighbors may lie outside the write scope | Skip NoData and never fill it. Default uses only same land / sea sign neighbors; `E=0` stays 0. This increment does not require an unprotected mode or resetting a paleoshoreline polygon. |
| Sea-level Shift | Finite `rise` in m; `R = E − rise` for valid scoped cells | Positive rise lowers relative elevation: `50 m − 100 m = −50 m`. Preserve NoData; range violations block atomically. A regional shift is a relative-datum scenario, not globally consistent sea level. |

- **Preview / Apply.** Reuse Live Preview → inspect → explicit Apply, including retained stale Preview when Live Preview is off. Parameter, scope / selection, or committed-input changes refresh or invalidate Preview. Show tool / scope, valid / NoData / changed counts, result and delta statistics. Drawing geometry is not a prerequisite for these operations.
- **Storage / audit.** Finite transforms store derived `ΔE = R − E_base`. Fill records the NoData→valid transition plus a declared finite fill base separately; never compute `R − NaN` or silently use zero as NoData. Undo restores prior values and validity; Redo restores the same result. Record algorithm ID / version, input revision, scope mask, method / parameters, and NoData policy in the existing operation / History audit path.
- **Atomicity.** Validate all parameters and the proposed result against Float32 finite-value semantics and the inclusive hard range. Invalid parameters, missing donors, stale Preview, range violations, or no write lease commit nothing: no partial raster / layer / History / outbox writes, no silent clamp. One changed Apply is one undoable operation and pending cloud record.
- **Boundaries.** Longitude wraps; polar rows clip; out-of-scope cells stay bit-for-bit unchanged. Source NetCDF remains read-only. Copy From, derived-layer stale / cascade, write lease, and cloud outbox keep existing semantics / simulation labels. This does not add real multi-source I/O or a production GIS backend.

### 7.9 Live Preview / Apply

- **Purpose.** Show terrain result without committing; commit only on Apply.
- **Entry.** Tool properties `实时预览 / Live Preview` (on by default; persists across terrain tools) and Preview / Apply buttons.
- **Preconditions.** Geometry ready for a generator, or a valid explicit scope / eligible target for a scoped DEM operation; parameters valid.
- **Behavior.** Live Preview on: finishing geometry or changing height/width/blend/seed/profile/mask/NoData base regenerates Preview without a Preview click. Approved extension: scoped DEM parameters, scope / selection, and committed-input changes also refresh or invalidate Preview; these tools do not need geometry. Apply stays explicit and enabled only after a fresh in-range preview. Live Preview off: parameter changes do not regenerate; last Preview stays visible and is labeled `预览已过期 / Preview out of date` until Preview or Live Preview refreshes it.
- **Visible feedback.** Inline preview status; canvas stale badge; focused parameter field is kept. No per-keystroke toast.
- **Result.** Preview arrays are non-destructive. Apply writes the working surface.
- **Exceptions.** Out-of-range automatic preview shows the violation and keeps Apply disabled.

### 7.10 Layers / History / Difference

- **Purpose.** Inspect composition, undo, and compare.
- **Entry.** Dock tabs Layers / History; canvas After / Before / Difference / Split View.
- **Preconditions.** Document is open.
- **Behavior.** Layers evaluate bottom-to-top: source at bottom, Edit Layers, Selection Mask, optional Copy From groups. Derived `ΔE` layers can be stale; enabled stale layers block export; Recompute Affected is explicit, cascades enabled upper derived layers, and is atomic. History lists selections and edits; Undo/Redo restore raster and selection. Difference is a diverging zero-centered comparison of the current age.
- **Visible feedback.** Stale badges; cascade order; current History row; view-mode `aria-pressed`.
- **Result.** Reviewer can hide/show demo groups, undo, and compare.
- **Exceptions.** Failed cascade rolls back all staged tiles and writes one failure History event. Prototype stale/cascade UI is a labeled demo, not live raster evaluation. Layer move is not implemented.

### 7.11 Copy From Previous Age

- **Purpose.** In a later age, pull work from an earlier age as an independent group.
- **Entry.** Enter 90 Ma or 80 Ma, then `从之前年龄复制 / Copy From Previous Age`.
- **Preconditions.** Current age is not the oldest. Write lease held.
- **Behavior.** Default source is the previous available age (drafts allowed). Entire previous age is default; selected content requires ≥1 item. Confirm Copy adds a `来自 <source> / From <source>` group **above** existing target work and never replaces it. Canvas switches to Difference of current age before vs after that group. Later source edits do not mutate the copy; `来源已有更新 / Source has newer changes` is informational. Review update is non-mutating. Bring in update adds `From <source> · Latest`. Use Latest or Keep Current finishes the comparison.
- **Visible feedback.** Dialog preview; group name/status; Difference cue; finish bar.
- **Result.** Independent target-age snapshot; one History / pending edit per Confirm, Bring in update, Use Latest, or Keep Current.
- **Exceptions.** Apply on the source age never copies. Prototype does not load 90 Ma / 80 Ma rasters.

### 7.12 Export

- **Purpose.** Produce a new NetCDF-4 copy plus an operation manifest.
- **Entry.** `导出 / Export`.
- **Preconditions.** No enabled stale derived layer. All finite elevations in range. Write path is a new file.
- **Behavior.** Default: preserve source layout. Custom: Deflate/Shuffle/chunks. Prototype validates and does not write a file.
- **Visible feedback.** Dialog; toast pass/block.
- **Result.** Validation message naming the mapped variable.
- **Exceptions.** Stale, range, or read-only: dialog stays closed or confirm is blocked; no History.

### 7.13 Cloud state and permissions

- **Purpose.** Durable local snapshot plus single-writer cloud sync.
- **Entry.** Header sync chip; Sync now; Demo scenarios other-writer lease.
- **Preconditions.** Local `.pdemproj` writes first. Cloud acknowledgement advances revision.
- **Behavior.** Committed edits enqueue idempotent outbox records. Failed cascade enqueues nothing. Sync now acknowledges in order (simulation). One write lease per project; other clients are read-only. Selection, view, and Difference remain usable when read-only. Lease token is never shown.
- **Visible feedback.** `本机写入 / This device` or `只读 / Read-only`; pending count; revision.
- **Result.** Pending cleared only after simulated acknowledgement.
- **Exceptions.** Uncertain or other-writer lease: project-changing actions toast read-only and preserve the local package and outbox. No real backend, credentials, or lock service.

## 8. User scenarios

1. Approved scenario: select a mountain candidate with Landform Select, Shift/Ctrl-add another, Quick Add / Subtract to correct boundaries, Regional Rescale Preview, inspect, Apply.
2. Approved scenario: use Quick twice over different elevations and NoData; footprints union. Use one-shot New then Add, or a Subtract stroke; Undo/Redo restores one stroke.
3. Draw a ridge, keep Live Preview on, tweak width, Apply to 100 Ma only; retain the existing named generators.
4. Approved scenario: select a small NoData gap, Fill NoData with bounded IDW, inspect and Apply; separately smooth a seam without filling NoData or changing sea / land sign.
5. Approved scenario: explicitly inspect Whole DEM scope, preview a +100 m sea-level rise, confirm that relative E decreases, Apply / Undo.
6. Enter 90 Ma, Copy From 100 Ma, inspect Difference, keep existing 90 Ma work.
7. Recompute stale derived layers, Sync now, Export after validation. These remain labeled simulations where specified.

## 9. End-to-end workflows

```text
Open age → map E → define region (Landform / Cell / Polygon / expression; Quick corrects)
  → modify usable relief, generate missing features, or repair gaps / seams
  → explicit scope + parameters → Live Preview → inspect → Apply current age
  → Layers / History / Difference
  → optional Copy From on a later age
  → Export copy (blocked if stale or out of range)
```

Terrain Apply never targets other ages. Cross-age reuse is always a later-age Copy From. This guide is optional and concise, not a required wizard. External data preparation, true paleoshoreline constraints, and multi-source compile are documented future workflows, not simulated execution buttons.

## 10. Interaction rules

- Chinese first, English second. Do not translate `E`, units, CRS, algorithm IDs.
- Preserve the dense PS / QGIS desktop workbench. Icon-only rail stays **46 px**, using bilingual geological tool-name overlays after **100 ms**, not native `title` or permanent rail labels.
- Approved options-bar order: **取消选择 / Deselect → 反选 / Inverse → current tool → contextual modes / options**. These actions are at the actual far left in DOM and visual order, not merely first inside a right-side group. Undo/Redo may remain right. Keep compact readable bilingual names at 1024 / 1280 / 1440 px.
- Tab toggles panels only when the canvas is focused.
- Undo/Redo, Deselect, Inverse keep platform chords: ⌘/Ctrl+Z, ⇧⌘/Ctrl+Z, ⌘/Ctrl+D, ⇧⌘/Ctrl+I.
- Text inputs and open dialogs do not fire document tool shortcuts.
- Selection modifiers show the actual operation and clear on keyup / blur / tool change. Quick retains its independent three-mode state; other tools retain the generic four-mode state.
- Quick Selection locks mode at pointer-down; Polygon locks at first vertex. Feedback during a gesture reflects the locked mode, not subsequently pressed keys.
- Suppress the editing-canvas context menu only while a selection tool is active so macOS Ctrl-click can Add; do not suppress unrelated page context menus.

## 11. Validation and error states

| State | Feedback | Mutation |
| --- | --- | --- |
| Selection unchanged | Toast | No History |
| No matching landform / NoData click | Explicit no-match feedback | Preserve existing mask; no History |
| Empty selected scope / no eligible target | Scope / count feedback; Apply blocked | No fallback to Whole DEM; no History / outbox |
| Invalid parameters / flat rescale source / missing IDW donor | Reason and corrective hint; Apply blocked | No partial edit / History / outbox |
| Invalid expression | Inline error | No mask change |
| Out-of-range preview | Warning; Apply disabled | No Apply / History |
| Out-of-range direct edit | Toast blocked | No History |
| Enabled stale derived layer | Stale badge | Export blocked |
| Cascade failure | Toast rollback; failure History | Pre-action caches restored |
| Read-only lease | Header + toast | Outbox preserved |
| Copy From no items | Confirm disabled | No copy |
| Prototype age switch | Toast raster not loaded | Context only |

## 12. Adobe citations

Represented accurately; do not overstate:

- Magic Wand tool techniques (New / Add / Subtract / Intersect controls):  
  <https://helpx.adobe.com/photoshop/using/tool-techniques/magic-wand-tool.html>
- Add to / subtract from selections (Shift adds; Alt Windows / Option macOS subtracts):  
  <https://www.adobe.com/learn/photoshop/web/add-to-subtract-from-selections>
- Current Quick Selection (New / Add / Subtract; painting expands along image edges):  
  <https://helpx.adobe.com/photoshop/desktop/make-selections/automatic-color-based-selections/paint-a-selection-with-quick-selection-tool.html>

Adobe documents Shift Add and Alt/Option Subtract, **not** Ctrl Add. PaleoDEM retains Ctrl/Cmd Add for compatibility; Ctrl/Cmd+Alt Intersect is limited to generic pointer selection tools. Quick has only three modes and Alt wins combined chords. Its footprint-union behavior is the user's deliberate DEM adaptation, not Adobe's image segmentation. Landform Select is an independent DEM heuristic, not a renamed Photoshop Wand algorithm. The macOS Ctrl-click context-menu exception is limited to the selection canvas.

## 13. Business-level permissions and cloud sync

- Source NetCDF is read-only. Export writes a new copy.
- Local `.pdemproj` is the offline snapshot.
- Cloud project: monotonic revision, idempotent outbox, server acknowledgement required.
- Single-writer lease; readers keep view/selection/Difference.
- Prototype only: labeled simulation, no backend, no secrets.

## 14. Acceptance criteria (implemented prototype increment)

The criteria below were the approved implementation contract. This run recorded prototype evidence against them. Do not reuse the prior Wand screenshot as proof of the new behaviors. Parent owner verification is still required before claiming product-complete.

1. Controlled-grid tests separately prove mountain prominence (reject high flat interior and tilted planar ramps), valley concavity (reject uniformly deep ocean and tilted planar ramps), and a narrow valid coastal band (reject ocean / land interiors and NoData edges). Isolated ridge / trough acceptance is required. Candidates are deterministic and connected; no-match and NoData clicks preserve the mask; applied edits affect subsequent classification; date-line continuity and polar clipping pass.
2. Cell / Landform / Polygon keep New/Add/Subtract/Intersect; expression selection uses generic persistent state. Quick only exposes New/Add/Subtract, independently remembered, first-use Add preserves existing selection, and explicit New replaces one stroke then returns to Add.
3. Two Quick clicks / drags union full footprints across differing elevations and NoData; sparse moves interpolate without holes and use shortest longitude wrap; Subtract is exact. A changed stroke is one History command; unchanged strokes create none; Undo/Redo restore masks.
4. Shift / Ctrl/Cmd Add and Alt/Option Subtract work; generic combined chords Intersect but Quick combined chords Subtract. Quick locks at pointer-down and Polygon at first vertex. Toolbar feedback matches the locked / effective operation and does not stick after keyup, blur, or tool changes; Quick / generic persistent states do not overwrite each other.
5. Text fields and dialogs do not trigger document shortcuts. Selection-canvas macOS Ctrl-click works without a context menu; unrelated page / non-selection context-menu behavior is not globally suppressed.
6. DOM and visual order put Deselect / Inverse at the actual far left before tool / mode controls, preserving shortcuts. Toolbox-related labels consistently say 地形工具 / Terrain Tools; task groups, active geological names, tooltips, bilingual search, empty results / reset, and stable existing algorithm IDs agree. Line Coastal Uplift / Lowering is not mislabeled as Set Paleoshorelines.
7. At 1024 / 1280 / 1440 px, primary actions remain readable, the 46 px rail / 100 ms tooltip is stable, and the dense workbench is retained without cards, a forced wizard, or future-operation placebo buttons.
8. Each of the four DEM operations passes known-grid arithmetic, current-committed-input, selection-only write scope, empty-selection block, explicit full-scope, NoData, date-line / polar, parameter and hard-range tests. Include flat-rescale rejection, fixed fill / frozen-donor IDW with atomic missing-donor rejection, default sign-protected smoothing preserving zeros and gaps, and positive sea-level rise decreasing E.
9. Each operation has non-destructive fresh / stale Preview, explicit Apply, exact value / validity Undo/Redo, derived finite delta / explicit fill-base audit, and one changed Apply / outbox record. Invalid, unchanged, stale, or read-only cases write no partial result or spurious History / pending change.
10. Existing terrain generation, retained stale Preview, Layers / History / Difference, target-initiated Copy From and finish comparison, export guards, write lease, and cloud outbox simulations remain covered. Only explicitly superseded Wand / similarity / four-mode Quick assertions are updated; do not silently delete regression coverage.
11. Record exact `node --check` results for prototype app / tests, `node --test prototypes/paleodem-editor/workbench.test.mjs`, `npm test`, `npm run build`, and real-browser CDP results. Do not assume initial failures are pre-existing. Clean 100 Ma After screenshots show Landform Select, multi-stroke selection, and named Terrain Tools with no unrelated modal / geometry / toast leftovers. Final implementation-owner browser verification is required before claiming done.

## 15. Known prototype limits

- Synthetic 96×54 raster; no real NetCDF read/write.
- 90 Ma / 80 Ma are document context only.
- Copy From, stale cascade, cloud sync, and write lease are labeled simulations.
- Pan/zoom, true layer reorder, Worker/tile-delta, and production performance are not implemented.
- Native focus, pointer feel, and screenshots require a real browser; JSDOM tests do not prove pixels.
- Landform heuristics and scoped DEM operations are grid-scale approximations on the synthetic 96×54 raster, not kilometer-scale geological models or scientific accuracy claims. Fixed prototype defaults are recorded in §17.
- Research covers official v1.1-era documentation and a separately identified inspected source commit, not unverified later releases. Multi-source compile, true polygon paleoshorelines, age-depth bathymetry, and ice-load compensation remain data-dependent future capabilities; no blocking product choice remains for the approved prototype scope.

## 16. Source references

- Prototype: `prototypes/paleodem-editor/index.html`, `app.js`, `styles.css`, `workbench.test.mjs`
- Decision PRD: `docs/paleodem-editor-prd.md`
- Terra Antiqua research / all 13 official tool citations and formula discrepancies: [Chinese research report](./paleodem-terra-antiqua-research.zh-CN.md)
- Official Terra Antiqua manual: <https://jaminzoda.github.io/terra-antiqua-documentation/>
- QGIS Terra Antiqua listing (captured stable 1.1): <https://plugins.qgis.org/plugins/terra_antiqua/>
- Adobe Quick Selection: <https://helpx.adobe.com/photoshop/desktop/make-selections/automatic-color-based-selections/paint-a-selection-with-quick-selection-tool.html>
- Adobe Magic Wand: <https://helpx.adobe.com/photoshop/using/tool-techniques/magic-wand-tool.html>
- Adobe add/subtract selections: <https://www.adobe.com/learn/photoshop/web/add-to-subtract-from-selections>
- QGIS Processing Toolbox and expressions (product model, not implemented as QGIS)
- Google Maps polygon drawing pattern (vertex click / preview edge)

## 17. Prototype implementation record (this increment)

Documentation-stage copies of this PRD marked the increment **approved pending implementation**. That record is historical. The following defaults were fixed in `prototypes/paleodem-editor` and exercised by tests / CDP in this run:

| Item | Implemented default / ID |
| --- | --- |
| Landform neighborhood radius | `2` cells (documented, not a free control) |
| Landform connectivity | `4` or `8` adjacency (`state.neighbors`, default `8`); labeled 邻接 / Connectivity, not a radius |
| Landform sensitivity | Low `relief 350 / residual ±180` m; Medium `180 / ±90` (default); High `80 / ±35`. Residual is center minus the mean of other finite cells in the 2-cell window; mountains require residual `> +threshold`, valleys `< −threshold`. Horizontal flats and tilted planar ramps (residual ≈ 0) are rejected. |
| Local surface revision | `state.surfaceRevision` increments only when committed Float32 values/validity change. Distinct from simulated cloud `project.lastSyncedRevision`. |
| Quick first-use mode | Add; independent of generic `selectionMode`. Explicit New is consumed even when the stroke does not change the mask. |
| Fill IDW | radius `1–6` cells, default `3`; weight `1/d^2`; frozen snapshot; missing donor blocks entirely; blank/noninteger/out-of-bounds radius is invalid (no silent clamp) |
| Smooth | radius `1–3` cells, default `1`; same land/sea sign; `E=0` unchanged; NoData skipped; radius `0` / noninteger / out-of-bounds is invalid |
| Algorithm IDs | `paleodem.rescale.v1`, `paleodem.fill.v1`, `paleodem.smooth.v1`, `paleodem.sea-level.v1` |
| Scoped Apply audit | History extras store algorithm ID, local input revision/lineage, exact scope mask, method/parameters, NoData policy, finite `ΔE` rows, and explicit old/new validity plus finite fill-base records (fixed value or per-cell IDW result). Never `R−NaN` or `fillBase: undefined`. |
| Unchanged Apply | Proposed vs committed Float32 values and validity are compared; identity sea-level / smoothing / rescale reports `No change` and writes no edit count / History / outbox. |
| Scope display / statistics | The options-bar scope follows the selected radio; result and delta statistics are restricted to that write scope. |
| Narrow desktop options | The options row grows to fit wrapped Landform controls (77 px at 1024); Chinese action names remain visible and controls are not clipped. |

**Final parent verification** (Node v26.8.1)

- `node --check prototypes/paleodem-editor/app.js` and `workbench.test.mjs`: passed
- `node --test prototypes/paleodem-editor/workbench.test.mjs`: 47 pass / 0 fail
- `npm run build`: passed (`tsc --noEmit && vite build`)
- `npm test` (vitest): 16 passed + 1 skipped files; 83 passed + 5 skipped tests; 0 failed. Earlier child-run `node:` import failures were not reproduced in the parent final run; the affected project test files were not changed.
- CDP: `PALEODEM_EDITOR_URL=http://127.0.0.1:18222/prototypes/paleodem-editor/` against a dedicated headless Chrome profile (closed after); smoke exit 0; HTTP 200; 0 console/page/request errors; 20 toolbox algorithm entries; Mountains connected candidate 151 cells (NoData click preserved that mask); Quick pointer click then drag unioned footprints; Blend Seam active name; tooltip `地貌选取 / Landform Select · W`; blur restored Quick Add.
- Layout CDP: 1440 / 1280 / 1024 kept Chinese Deselect/Inverse text, 46 px rail, no options-bar overflow, no leftover dialog/toast. Screenshots: `/tmp/paleodem-terra-antiqua-research/screenshots/100ma-after-landform-1440.png`, `100ma-after-landform-options-1024.png`, `100ma-after-quick-1440.png`, `100ma-after-terrain-tools-1440.png`, `100ma-after-scoped-preview-1440.png` (plus 1280/1024 expanded Terrain Tools).
- Service: reused existing Vite PID 39887 on port 18222; dedicated test Chrome was closed; 18222 remained listening.
