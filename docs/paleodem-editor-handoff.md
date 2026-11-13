# PaleoDEM Editor — Operational Handoff

> Prototype-only workbench. Canonical UI is unchanged: do not edit `docs/ui-reference/canonical/index.html`.  
> Authoritative features: [`paleodem-editor-functional-prd.md`](./paleodem-editor-functional-prd.md).  
> Decision/history: [`paleodem-editor-prd.md`](./paleodem-editor-prd.md).  
> No secrets, tokens, or production hosts in this file.

## 1. File map

| Path | Role |
| --- | --- |
| `prototypes/paleodem-editor/index.html` | Workbench markup, bilingual chrome, dialogs, selection-mode buttons, shortcuts |
| `prototypes/paleodem-editor/app.js` | Synthetic DEM, selection, terrain, Live Preview, Copy From, cloud/lease simulation |
| `prototypes/paleodem-editor/styles.css` | Desktop workbench layout |
| `prototypes/paleodem-editor/workbench.test.mjs` | JSDOM/event regression, including selection modifiers |
| `/tmp/paleodem-editor-cdp-smoke.mjs` | Real-browser CDP smoke + modifier regression |
| `docs/paleodem-editor-functional-prd.md` | Authoritative feature PRD |
| `docs/paleodem-editor-prd.md` | Decision/history D-001–D-033 |
| `docs/paleodem-editor-handoff.md` | This file |
| `node_modules/.bin/vite` | Repository-local Vite executable used for LAN publish |

## 2. Main functions (`app.js`)

| Function | Responsibility |
| --- | --- |
| `modifierSelectionMode` | Shift/Ctrl/Meta → Add, Alt → Subtract; generic combined → Intersect; Quick Alt wins |
| `persistentSelectionMode` / `lockedSelectionMode` / `visibleSelectionMode` | Quick independent mode, gesture lock, toolbar overlay |
| `landformQualifyingMask` / `selectWithLandform` | Mountains / valleys / coastlines on committed DEM |
| `beginBrushGesture` / `addBrushCandidate` / `finishBrushGesture` | Quick footprint union, sparse wrap stamps, one-shot New→Add |
| `scopedDemResult` / `rescaleScopedValues` / `fillNoDataScopedValues` / `smoothScopedValues` / `seaLevelShiftValues` | Four scoped DEM ops |
| `maybeLivePreviewTerrain` / `applyTerrain` | Non-destructive preview; explicit Apply on current age |
| `confirmCopyFrom` / finish-comparison handlers | Target-side Copy From simulation |
| `guardWriteLease` / `syncProjectNow` | Read-only vs this-device writer; simulated outbox |
| `window.__paleodemTestApi` | CDP-only island / landform / Quick probes; not a product control |

## 3. Test commands

```bash
cd /Users/user/Desktop/Work/CodeRepo/TimeMachineWeb
node --check prototypes/paleodem-editor/app.js
node --check prototypes/paleodem-editor/workbench.test.mjs
node --test prototypes/paleodem-editor/workbench.test.mjs
npm run build
npm test
```

CDP (after a prototype server is up):

```bash
# PALEODEM_EDITOR_URL defaults to http://127.0.0.1:5173/prototypes/paleodem-editor/
PALEODEM_EDITOR_URL=http://127.0.0.1:18222/prototypes/paleodem-editor/ \
  node /tmp/paleodem-editor-cdp-smoke.mjs <DevToolsActivePort> /tmp/paleodem-editor-cdp-smoke.png
```

Expected prototype node tests this increment: 47 pass / 0 fail.

## 4. Limitations

- Synthetic 96×54 raster; no NetCDF I/O.
- 90 Ma / 80 Ma are context switches, not loaded rasters.
- Copy From, stale cascade, cloud sync, and write lease are labeled simulations.
- Pan/zoom, layer reorder, Worker/tile-delta, and production performance are not implemented.
- JSDOM tests do not prove pixels. CDP + `/tmp/paleodem-editor-selection-modifiers.png` cover browser modifiers.
- Bind is local LAN only. Do not change firewall or global environment.

## 5. LAN publish (0.0.0.0:18222)

Target bind: `0.0.0.0:18222` with `--strictPort`.  
Log: `/tmp/timemachineweb-paleodem-18222.log`  
PID file: `/tmp/timemachineweb-paleodem-18222.pid`

Never kill an unrelated listener on 18222. If this exact prototype is already bound, reuse it. If something else owns the port, stop and report a blocker.

### Start (only when 18222 is free)

```bash
cd /Users/user/Desktop/Work/CodeRepo/TimeMachineWeb
nohup ./node_modules/.bin/vite --host 0.0.0.0 --port 18222 --strictPort \
  > /tmp/timemachineweb-paleodem-18222.log 2>&1 &
echo $! > /tmp/timemachineweb-paleodem-18222.pid
```

### Verify process and HTTP

```bash
cat /tmp/timemachineweb-paleodem-18222.pid
lsof -nP -iTCP:18222 -sTCP:LISTEN
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18222/prototypes/paleodem-editor/
```

Live LAN IPv4 must be measured at publish time with `ipconfig getifaddr en0`; do not hard-code the current private address in repository documentation.

### Safe stop / restart

```bash
# Stop only the PID recorded for this prototype
kill "$(cat /tmp/timemachineweb-paleodem-18222.pid)"
# Confirm 18222 is gone, then start again with the nohup command above
```

Do not `kill` by port if the listener command is not this Vite prototype.

### Recorded runtime (verified at publish)

| Item | Value |
| --- | --- |
| Listener PID | `39887` |
| Command | `node ./node_modules/.bin/vite --host 0.0.0.0 --port 18222 --strictPort` |
| Bind | `0.0.0.0:18222` (`TCP *:18222`) |
| Loopback URL | `http://127.0.0.1:18222/prototypes/paleodem-editor/` |
| Live LAN IPv4 | Resolve at runtime with `ipconfig getifaddr en0` |
| Live LAN URL | `http://<LAN_IP>:18222/prototypes/paleodem-editor/` |
| HTTP status | `200` on loopback and LAN |
| PID file | `/tmp/timemachineweb-paleodem-18222.pid` (actual node listener, not the shell wrapper) |
| Log | `/tmp/timemachineweb-paleodem-18222.log` |
| Multi-island screenshot | `/tmp/paleodem-editor-selection-modifiers.png` |

## 6. Adobe citations

- Magic Wand New / Add / Subtract / Intersect:  
  <https://helpx.adobe.com/photoshop/using/tool-techniques/magic-wand-tool.html>
- Shift adds; Alt (Windows) / Option (macOS) subtracts:  
  <https://www.adobe.com/learn/photoshop/web/add-to-subtract-from-selections>

Ctrl/Cmd Add is a PaleoDEM extension. Do not claim Adobe documents Ctrl as Add.

## 7. Test results

| Check | Result |
| --- | --- |
| `node --check` app.js + workbench.test.mjs | passed |
| `node --test prototypes/paleodem-editor/workbench.test.mjs` | final parent verification: 47 pass / 0 fail (Node v26.8.1) |
| `npm run build` | passed (`tsc --noEmit && vite build`) |
| `npm test` | final parent verification: 16 passed + 1 skipped files; 83 passed + 5 skipped tests; 0 failed |
| CDP smoke | passed on dedicated headless Chrome profile (closed after); `PALEODEM_EDITOR_URL=http://127.0.0.1:18222/prototypes/paleodem-editor/`; HTTP 200; 0 console/page/request errors; Mountains 151 cells (not whole-ocean slope); 20 toolbox algorithms |
| Clean 100 Ma After screenshots | landform 1440; landform options 1024; Quick pointer click/drag 1440; Terrain Tools expanded 1440/1280/1024; scoped Sea-level Current Selection + fresh preview 1440 |
| Layout 1024 / 1280 / 1440 | Chinese Deselect/Inverse kept; 46 px rail; no horizontal overflow. At 1024, the Landform options bar grows to 77 px; all controls are within its bounds and pass center-point hit tests. |
| Scoped preview display | Options-bar scope matches the radios. Result and ΔE statistics use only the write scope; a one-cell −100 m change reports mean −100 m. |
| Diagnostics | LSP confirms both JS files clean; session diagnostics have no issues for edited prototype JS/test/CSS files. |

Earlier child runs reported `No such built-in module: node:` in two unmodified project test suites. The final parent rerun passes without edits to those suites; the earlier runner difference was not diagnosed. Final logs and browser JSON are under `/tmp/paleodem-terra-antiqua-research/final-*`.

## 8. Acceptance checklist

- [x] Landform Select replaces tolerance Wand with mountains / valleys / coastlines heuristics.
- [x] Quick footprint union, default Add, one-shot New→Add, Alt wins combined chords, no Intersect.
- [x] Deselect / Inverse are the actual far-left options-bar actions with bilingual text.
- [x] Toolbox labels say 地形工具 / Terrain Tools; coastline is Coastal Uplift / Lowering.
- [x] Four scoped DEM operations: rescale, fill (fixed/IDW), sign-protected smooth, sea-level.
- [x] Existing Copy From / lease / stale preview / terrain generators remain covered.
- [x] 47 prototype tests pass; project tests pass (83 + 5 skipped); build and dedicated-profile CDP smoke pass.
- [x] Canonical UI file not modified; port 18222 reused; test Chrome closed.
- [x] Parent final browser verification: real Quick click/drag, visible 1024 Landform controls, expanded named Terrain Tools, scope-consistent preview statistics.

## 9. Residual risks

- CDP depends on a local Chrome with DevTools and on the live prototype URL.
- LAN IPv4 can change; always re-read the active interface.
- Port 18222 may already belong to another process; do not hijack it.
- Prototype cloud/lease/Copy From remain simulations.
