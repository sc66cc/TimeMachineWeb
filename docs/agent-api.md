# TimeMachine Web agent API

`window.timeMachineAgent` is an in-page action facade. Automated callers drive
the same handlers the UI drives; there is no synthetic `element.click()`. The
facade adds no HTTP endpoint of its own: it is a frozen object with exactly
`version`, `execute`, `getState` and `listActions`. When an action does talk to
the Server, it goes through the same clients the UI uses and is bound by the
current session's permissions, so the facade is a convenience for driving the
app, not a second authentication path or a security boundary.

```js
const agent = window.timeMachineAgent;
const state = agent.getState();          // safe snapshot, never contains credentials
const actions = agent.listActions();     // honest inventory of this build
const result = await agent.execute("layer.setVisibility", {
  layerId: 3,
  active: false,
});
```

## Contract

Every call resolves to exactly one of:

```ts
// success
{ actionId, ok: true, data?, reloadRequired? }
// failure
{ actionId, ok: false, error: { code, kind, message } }
```

| `kind` | code | meaning |
| --- | --- | --- |
| `validation` | 400 | the parameters were rejected; nothing was changed |
| `auth` | 401 | sign in (again) before retrying |
| `busy` | 409 | another run of the same action is in flight |
| `unsupported` | 501 | this build or this Server cannot do it |
| `internal` | 500 | an unexpected failure; the message is redacted |

Rules the handlers follow:

- **Async actions wait for the real work.** An action either resolves after the
  work finished, or answers `reloadRequired: true` with `accepted: true` and a
  state the caller can re-check. `bootId` in `getState()` changes on every page
  load, so a caller waits for the new `bootId` instead of assuming a navigation
  happened.
- **Nothing sensitive is returned.** Results, state sections and error messages
  pass through a redactor that drops sensitive keys, strips `token=` /
  `Authorization:` / password literals from plain string values (so a network
  error stored in `catalog.error` cannot leak a credential), truncates structure
  deeper than four levels and breaks cycles. The facade itself is a frozen
  object with exactly `version`, `execute`, `getState` and `listActions`; the
  registry and its internal maps are not reachable from the page.
- **Enums are validated.** An unknown `tab`, `mode`, `source`, `module` or
  `step` is a `validation` failure, never a silent default.
- **`alpha` is validated.** A value outside `[0, 1]` is rejected; the returned
  `effective` value is the one actually applied.
- **A V1-only Server reports `unsupported`.** `project.save`, `project.open`,
  `dataset.select` and `upload.*` answer `501` and are listed as `unsupported`
  in `listActions()` instead of failing internally. The V2 capability is
  discovered asynchronously, so this is evaluated on every call: the real
  handler stays registered while the capability is missing and becomes usable
  the moment the Server's capability handshake reports V2 support.

## Projection MVP capability boundaries

The `projection.select` action and the Projection select in `.view-options` are
the operational Rectangle (Plate Carrée) MVP. What is and is not delivered:

- **Delivered.** `globe` (the existing 3D scene) and `rectangle` (native
  `SCENE2D` + `GeographicProjection(SPHERICAL_EARTH)`), on the same Viewer, with
  the plate-model layer only. Switching, per-mode time changes, the plate-only
  capability gate, the layer guard, Home and the return-to-globe camera are all
  wired through one latest-request control shared by the UI and the facade.
- **Not delivered.** Mollweide (`unsupported`), and the points / raster / atlas
  layers inside `rectangle`. The GPU point shader and the imagery adapters are
  still globe-only, so a visible points/raster/atlas layer blocks `rectangle`
  until it is explicitly turned off; it is never hidden automatically.
- The projection is page-session state only. A reload always starts on `globe`,
  and the 2D camera is never written into the project's ECEF camera snapshot.
- Control points, pole/seam handling, picking inside `rectangle`, tile loading
  and full per-layer alignment are verified separately in a real browser against
  the signed-in account; the facade and this document do not by themselves prove
  them.

## State sections

`getState()` returns `{ bootId, ...sections }`:

| section | registered by | contents |
| --- | --- | --- |
| `session` | AppShell | `accountName`, `signedIn`, `status`, `v2WorkspaceAvailable` |
| `catalog` | AppShell | shared plate model `status`, `total`, `error`, scalar `models` |
| `selection` | AppShell | the persisted resource selection |
| `ui` | AppShell | `accountMenuOpen`, `activeSidebarTab`, `authDialogOpen`, `authMode`, `busy`, `toolbarCollapsed`, `uploadStep`, `uploadWizardOpen` |
| `time` | main.ts | `ageMa`, `playing`, `speedMaPerSecond` |
| `plateModel` | main.ts | `loadStatus`, `loadError`, `loadedSource`, `loadedModelId`, `loadedModelName`, `featureCount`, `polygonCount`, `rotationSequenceCount`, `unsupportedGeometryCount` |
| `layers` | main.ts | scalar `groups` and `layers` (id, active, alpha, type, sourceRef) |
| `points` | main.ts | `datasetId` (loaded dataset), `loaded`, `selectedDatasetId` |
| `projection` | main.ts | `requestedId`, `committedId`, `status`, `revision`, `committedTimeMa`, `requestedTimeMa`, `committedTimeState`, `lastError`, `availableModes` |

## Runtime ids

| id | meaning |
| --- | --- |
| layer `1` | Phanerozoic paleogeographic maps (atlas) |
| layer `2` | PBDB point dataset |
| layer `3` | Single raster layer |
| layer `4` | Plate model |
| group `101` | Data layers |
| group `102` | Reconstruction |

## Controls and the action each one maps to

Every button and key input in `AppShell.vue` carries a `data-action` attribute,
and a test asserts that every button has one and that every declared action is
either bound to a control or listed as gesture-only below. Where a control only
changes a value (`#project-name`, the layer checkboxes and opacity sliders, the
point size field), it calls the same function the action calls, so the UI and
the API can never write two different values.

| control | action |
| --- | --- |
| ☰ main menu | `ui.menu.toggle` (unsupported) |
| ⇧ Save to Cloud | `project.save` |
| account / sign-in button | `ui.accountMenu.toggle` |
| account menu · Refresh cloud | `catalog.refresh` |
| account menu · Sign out | `auth.logout` |
| ➤ Publish | `publish.run` (unsupported) |
| ⇩ Export | `export.run` (unsupported) |
| ♟ notifications | `ui.notifications.open` (unsupported) |
| ⚙ settings | `ui.settings.open` (unsupported) |
| ⓘ information | `ui.info.open` (unsupported) |
| `#project-name` | `project.setName` |
| sidebar · Layer tab | `ui.sidebar.select` (`tab: "layers"`) |
| sidebar · Plate Model tab | `ui.sidebar.select` (`tab: "plate-models"`) |
| layer search | `ui.layerSearch.set` |
| ↥ Upload to Layer | `upload.open` |
| ◉ Layer Style | `ui.layerStyle.open` |
| group collapse ‹/› | `layer.group.setCollapsed` |
| group visibility | `layer.group.setVisibility` |
| group opacity | `layer.group.setOpacity` |
| layer row (select) | `ui.layerStyle.open` |
| layer visibility | `layer.setVisibility` |
| layer ••• options | `ui.layerStyle.open` |
| layer opacity | `layer.setOpacity` |
| ▶ load points | `points.load` |
| × unload points | `points.unload` |
| benchmark dataset select | `points.selectDataset` |
| point colour / size / shape / pixels | `points.setStyle` |
| point plate / occurrence filters | `points.setStyle` |
| shared catalog ↻ | `catalog.refresh` |
| shared model · Use | `model.select` (`source: "shared"`) |
| PALEOMAP · Use | `model.select` (`source: "local-demo"`) |
| versioned catalog ↻ | `catalog.refresh` |
| versioned model · Use | `model.select` (`source: "v2"`) |
| dataset · Use | `dataset.select` |
| cloud project · Open | `project.open` |
| `#single-raster-select` | `raster.select` |
| `#single-raster-opacity` | `layer.setOpacity` (`layerId: 3`) |
| `#point-size` | `points.setSize` |
| module buttons | `ui.module.select` |
| toolbar ‹/› | `ui.toolbar.toggle` |
| Major cities | `ui.majorCities.setVisible` (unsupported) |
| place search | `ui.placeSearch` (unsupported) |
| Projection select | `projection.select` |
| ⌂ home camera | `camera.reset` |
| ◀ / ▶ transport | `time.set` (`ageMa: 100` / `0`) |
| play button | `time.setPlaying` |
| speed button | `time.setSpeed` |
| 0 today button | `time.set` (`ageMa: 0`) |
| timeline slider | `time.set` |
| 32 / 250 / 538.8 quick ages | `time.set` |
| auth dialog × | `ui.authDialog.close` |
| 账号密码 / 邮箱验证码 | `ui.authMode.set` |
| account / password fields | `auth.login` |
| account Sign in | `auth.login` |
| email field | `auth.sendCode` |
| code field | `auth.login` |
| Send code | `auth.sendCode` |
| email Sign in | `auth.login` |
| upload dialog × | `upload.close` |
| upload source file | `upload.run` (`file`) |
| upload name / description / plate model / mapping | `upload.run` |
| upload Back (file / map / run) | `ui.upload.back` |
| Start ingest | `upload.run` |
| Cancel job | `upload.cancel` |

### Gesture-only actions

These have no single button; they are the programmatic form of a gesture:

| action | gesture it replaces |
| --- | --- |
| `layer.setOrder` | drag-and-drop reordering in the layer list |
| `layer.setGroup` | dragging one layer into another group |
| `ui.accountMenu.setVisible` | deterministic show/hide of the account menu |
| `ui.authDialog.open` | the sign-in button while signed out |

## Action reference

### `auth.login` — Sign in

Sign in with a Unity account/password or an email verification code.

Params: 
- `mode` (string, optional) — 'account' (default) or 'email-code'.
- `account` (string, optional) — Unity account name (account mode).
- `password` (string, optional) — Plain password; never stored or logged.
- `email` (string, optional) — Email address (email-code mode).
- `code` (string, optional) — Verification code (email-code mode).

### `auth.sendCode` — Send an email verification code

Send an email verification code.

Params: 
- `email` (string) — Email address.

### `catalog.refresh` — Refresh the plate model catalog

Reload the shared plate model catalog (public pages plus the user's own).

Params: 
- none

### `model.select` — Select the plate model to load

Select the plate model to load. Reloads the page, so wait for bootId to change.

Params: 
- `source` (string, optional) — 'shared' (default), 'v2' or 'local-demo'.
- `plateModelId` (number, optional) — Shared plate model ID (source 'shared').
- `versionId` (number, optional) — Versioned plate model ID (source 'v2').

### `dataset.select` — Select a versioned point dataset

Select a versioned point dataset. Reloads the page.

Params: 
- `datasetVersionId` (number) — Versioned dataset ID.

### `project.save` — Save the project to the cloud

Save the project to the cloud. Requires the TimeMachine V2 workspace endpoints.

Params: 
- none

### `project.open` — Open a cloud project revision

Open a cloud project revision. Requires the TimeMachine V2 workspace endpoints.

Params: 
- `revisionId` (number) — Revision ID.

### `time.set` — Set the geological age

Set the geological age in Ma.

Params: 
- `ageMa` (number) — Age in Ma.

### `time.setPlaying` — Play or pause the time animation

Start or pause the geological time animation.

Params: 
- `playing` (boolean) — True to play, false to pause.

### `time.setSpeed` — Set the playback speed

Set the playback speed in Ma per second.

Params: 
- `speedMaPerSecond` (number) — Speed in Ma per second.

### `camera.reset` — Reset the globe to the home view

Reset the globe to the home view.

Params: 
- none

### `projection.select` — Switch the map projection

Switch the map projection. The UI select and this action share one handler, so a
programmatic switch behaves exactly like picking the option.

Params: 
- `projectionId` (string) — `globe`, `rectangle` or `mollweide`.

Behaviour:

- `globe` keeps the Cesium 3D scene; `rectangle` is the native 2D Plate Carrée
  view; `mollweide` is not implemented and answers `unsupported` (501).
- The promise resolves only after the target view has actually committed and
  rendered. In `rectangle` the CPU plate frame is prepared, uploaded, warmed up
  and verified before the commit, and the mode has really morphed to 2D.
- `rectangle` requires every points/raster/atlas layer to be off first.
  If one is still visible the call answers `unsupported` (501) and names the
  layers; the committed view is left untouched and no layer is hidden for you.
  Turn them off with `layer.setVisibility` and retry. Re-showing a layer group,
  moving a layer into a visible group, or a reorder that would make such a layer
  effective-visible is refused the same way (`validation`/400), from both the UI
  and the API, before anything is applied. Effective visibility is used, so a
  layer whose parent group stays hidden is not treated as shown.
- A newer request supersedes an in-flight one; the older promise settles as
  `busy` (409) without changing state. An unexpected failure is `internal` (500)
  and keeps the previously committed view. If the confirmation render itself
  errors, the switch fails without committing the new time and re-selecting the
  target mode rebuilds the view, so the scene is never left claiming a mode it
  did not actually render.
- This action never reloads the page. Read `getState().projection` for the
  `requestedId` / `committedId` / `status` / `revision` / committed time and the
  per-mode `availableModes`.

### `layer.setVisibility` — Show or hide a layer

Show or hide a layer.

Params: 
- `layerId` (number) — Layer id.
- `active` (boolean) — True to show.

### `layer.setOpacity` — Set a layer opacity

Set a layer opacity between 0 and 1.

Params: 
- `layerId` (number) — Layer id.
- `alpha` (number) — Opacity in [0, 1].

### `layer.group.setVisibility` — Show or hide a layer group

Show or hide a layer group.

Params: 
- `groupId` (number) — Group id.
- `active` (boolean) — True to show.

### `layer.group.setOpacity` — Set a layer group opacity

Set a layer group opacity between 0 and 1.

Params: 
- `groupId` (number) — Group id.
- `alpha` (number) — Opacity in [0, 1].

### `layer.group.setCollapsed` — Collapse or expand a layer group

Collapse or expand a layer group.

Params: 
- `groupId` (number) — Group id.
- `collapsed` (boolean) — True to collapse.

### `layer.setOrder` — Reorder layers

Reorder layers by their full ordered id list. `groupIdByLayer` is optional and moves a layer between groups while reordering, exactly like a drag-and-drop in the sidebar.

Params: 
- `orderedIds` (number[]) — Every layer id, in the new order.
- `groupIdByLayer` (object, optional) — Optional map of layer id to target group id (101 data, 102 reconstruction).

### `layer.setGroup` — Move a layer into another group

Move a layer into another group without reordering.

Params: 
- `layerId` (number) — Layer id.
- `groupId` (number) — Target group id.

### `points.load` — Load the selected point dataset

Load the selected point dataset. A network or GPU failure rejects, so the
action answers `ok: false` instead of pretending the dataset is ready.

Params: 
- none

Returns `datasetId` (the loaded dataset), `loaded` and `selectedDatasetId`.

### `points.unload` — Unload the point dataset

Unload the point dataset.

Params: 
- none

### `upload.open` — Open the upload wizard

Open the dataset upload wizard. Requires the V2 ingest endpoints.

Params: 
- none

### `upload.run` — Run the dataset ingest

Run the dataset ingest. The source file may be passed directly as a browser File/Blob, so no DOM interaction is required. Requires the V2 ingest endpoints.

Params: 
- `file` (object, optional) — Browser File or Blob holding the CSV/TSV/TXT payload.
- `name` (string, optional) — Dataset name.
- `description` (string, optional) — Dataset description.
- `plateModelId` (number, optional) — Plate model the dataset binds to.
- `mapping` (object, optional) — Column mapping override.

### `upload.cancel` — Cancel the running ingest job

Cancel the running ingest job. Requires the V2 ingest endpoints.

Params: 
- none

### `ui.layerSearch.set` — Filter the layer list

Filter the sidebar layer list by a substring.

Params: 
- `query` (string) — Substring to match; empty clears the filter.

### `ui.layerStyle.open` — Open a layer's style panel

Open a layer's inline style panel and select it.

Params: 
- `layerId` (number, optional) — Layer id to select.

### `ui.accountMenu.setVisible` — Show or hide the account menu

Show or hide the account menu in the top bar.

Params: 
- `visible` (boolean) — True to show the menu.

### `ui.accountMenu.toggle` — Toggle the account menu or open the sign-in dialog

Toggle the account menu, opening the sign-in dialog when signed out.

Params: 
- none

### `ui.authMode.set` — Switch the sign-in method

Switch the sign-in dialog between account/password and email code.

Params: 
- `mode` (string) — 'account' or 'email-code'.

### `ui.module.select` — Select a workspace module

Select a workspace module from the toolbar.

Params: 
- `module` (string) — One of the module labels shown in the toolbar.

### `project.setName` — Rename the project

Rename the project draft.

Params: 
- `name` (string) — New project name.

### `points.selectDataset` — Select the local benchmark point dataset

Select the local benchmark point dataset, optionally loading it.

Params: 
- `datasetId` (string) — Dataset id from the point-data manifest.
- `load` (boolean) — True to start loading immediately.

Returns:
- `datasetId` / `selectedDatasetId` — the dataset that was selected.
- `loaded` — true only when *that* dataset is the one in GPU memory, so
  selecting a second dataset with `load: false` answers `false` while the
  previously loaded dataset stays on screen.
- `loadedDatasetId` — the dataset currently in GPU memory (`""` when none).

### `points.setSize` — Set the point size in pixels

Set the point size in pixels. The size is the one stored in the session (and
therefore the one the point renderer draws with), so a call outside the range
is rejected with `validation` instead of being clamped.

Params: 
- `pointSize` (number) — Point size in pixels, between 0.5 and 8. Any finite value in
  that range is accepted as-is; the size control does not quantize it to a step.

Returns:
- `pointSize` — the stored point size in pixels.

### `points.setStyle` — Set the point style expression

Set the point layer style expression (colorMode, sizeMode, pointSize, shape, singleColor, filter).

Params: 
- `style` (object) — Partial point style expression.

### `raster.select` — Select the single raster layer source

Select the single raster layer source by id.

Params: 
- `rasterId` (string) — Raster id from the single-raster manifest.

### `ui.upload.back` — Go back one step in the upload wizard

Go back one step in the upload wizard.

Params: 
- `step` (string, optional) — 'select', 'map' or 'run'.

### `ui.menu.toggle` — Open the main menu

The main menu (☰) is not implemented; the button is a placeholder.

Params: 
- none

### `ui.settings.open` — Open settings

Settings (⚙) is not implemented; the button is a placeholder.

Params: 
- none

### `ui.info.open` — Show the information panel

Information (ⓘ) is not implemented; the button is a placeholder.

Params: 
- none

### `ui.notifications.open` — Show notifications

Notifications (♟) is not implemented; the button is a placeholder.

Params: 
- none

### `ui.placeSearch` — Search for a place on the globe

Place search is not implemented; the input is a placeholder with no globe lookup behind it.

Params: 
- `query` (string) — Place name to look up.

### `ui.majorCities.setVisible` — Show or hide major cities

Major cities is not implemented; the checkbox is a placeholder with no dataset behind it.

Params: 
- `visible` (boolean) — True to show major cities.

### `publish.run` — Publish the project

Publishing is not implemented; the button is a placeholder.

Params: 
- none

### `export.run` — Export the project

Export is not implemented; the button is a placeholder.

Params: 
- none
### `auth.logout` — Sign out

Sign out and reload the public catalog.

Params:
- none

### `ui.authDialog.open` — Open the sign-in dialog

Opens the sign-in dialog. The sign-in button does the same when signed out.

Params:
- none

### `ui.authDialog.close` — Close the sign-in dialog

Closes the sign-in dialog.

Params:
- none

### `ui.sidebar.select` — Switch the sidebar tab

Switches the sidebar between the Layer and Plate Model tabs.

Params:
- `tab` (string) — 'layers' or 'plate-models'.

### `ui.toolbar.toggle` — Collapse or expand the module toolbar

Collapses or expands the workspace module toolbar.

Params:
- none

### `upload.close` — Close the upload wizard

Closes the upload wizard. Refused with `busy` while an ingest job is running.

Params:
- none

## Examples

```js
// Hide the single raster layer and read back what was actually applied.
const hidden = await agent.execute("layer.setVisibility", {
  layerId: 3,
  active: false,
});
// { ok: true, data: { layerId: 3, active: false, effective: false } }

// Reorder every layer and move the atlas into the reconstruction group.
await agent.execute("layer.setOrder", {
  orderedIds: [4, 3, 2, 1],
  groupIdByLayer: { 1: 102 },
});

// Jump to the Cretaceous, pausing playback first (same as the quick-age buttons).
await agent.execute("time.set", { ageMa: 100 });

// Select the shared plate model and wait for the reload it schedules.
const before = agent.getState().bootId;
const selected = await agent.execute("model.select", { plateModelId: 42 });
if (selected.reloadRequired) {
  while (agent.getState().bootId === before) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Upload a dataset without touching the DOM.
await agent.execute("upload.run", {
  file: new File([csvText], "pbdb.csv", { type: "text/csv" }),
  name: "PBDB 2026",
  plateModelId: 101,
  mapping: {
    ageEndColumn: "max_ma",
    ageStartColumn: "min_ma",
    latitudeColumn: "lat",
    longitudeColumn: "lng",
    occurrenceColumn: "occurrence",
    plateIdColumn: "plate_id",
  },
});
```

## Controls that are deliberately unsupported

☰ main menu, ⚙ settings, ⓘ information, ♟ notifications, ➤ Publish, ⇩ Export,
Major cities and place search exist in the UI as placeholders. They are declared
as `unsupported`, so both the button and the API report the same thing rather
than pretending the feature exists.

## Verification

The behaviour above is covered by tests in `src/test`:

| file | what it pins down |
| --- | --- |
| `agent-facade-security.test.ts` | redaction of state/results/errors (including a labelled credential inside a plain string), depth truncation, cycles, error kinds, array/object parameters, frozen four-method facade, `listActions` copies, live availability in both directions |
| `layer-controller.test.ts` | the shared setter: renderer, native controls, published state, persistence, group members, order with `groupIdByLayer`, alpha and id rejection |
| `plate-source.test.ts` | explicit source resolution, `sourceRef` round-trip, one-source-only selection |
| `cloud-client-session.test.ts` | pagination de-duplication and `incomplete`, sign-in rollback, stale-session clearing, V2 failure keeping the V1 token, cloud-project source restore, SHA-256 digest golden |
| `agent-actions-appshell.test.ts` | the mounted real AppShell: V1 `unsupported` inventory, enum rejection, async failure, a credential in a real cloud error string redacted out of `getState`, a failing `auth.sendCode` reported as a failure with no unhandled rejection from the UI path, and the control-coverage audit |
| `agent-actions-v2-availability.test.ts` | a V2 capability handshake that resolves after mount: the same production handlers flip from `501 unsupported` to usable without being re-registered |
| `point-runtime-state.test.ts` | the point layer's stored style, visibility and opacity actually reaching the renderer |

Not covered by an automated test: the renderer-side effects of `main.ts`
(`layer.setVisibility` reaching Cesium, `time.set` pausing first,
`points.load` propagating a network/GPU failure, the V2 plate-model branch).
Those live behind `createViewer()` and need a browser; verify them against a
running candidate build.

Also not covered: an end-to-end run against a real Server with a real private
account (sign-in, cloud project open/save, ingest of a private dataset). Every
automated test here uses synthetic values, an offline `fetch` stub and no
credentials. Projection/reprojection of ingested point data is still pending
and has no action behind it.
