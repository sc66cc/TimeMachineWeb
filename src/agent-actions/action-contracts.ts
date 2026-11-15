import type { ApiContractMetadata } from "./contracts";

const reload = new Set(["model.select", "dataset.select", "project.open", "upload.run"]);
const remoteWrite = new Set(["auth.login", "auth.logout", "auth.sendCode", "project.save", "upload.run", "upload.cancel", "publish.run"]);
const future = new Set(["publish.run", "export.run", "ui.majorCities.setVisible", "ui.placeSearch", "ui.info.open", "ui.menu.toggle", "ui.notifications.open", "ui.settings.open"]);
const frameJobs = new Set(["time.set", "projection.select", "camera.reset", "raster.select", "points.load", "layer.add", "layer.remove", "layer.retry"]);

/** Lightweight metadata; schemas stay in a separate dynamic chunk. */
export function actionContractMetadata(id: string): ApiContractMetadata {
  const mayAutosave = id.startsWith("layer.") || ["points.setSize", "points.setStyle", "project.setName"].includes(id);
  const existing = id.startsWith("auth.") || id.startsWith("upload.") ||
    id.startsWith("ui.upload.") || id === "project.save" || id === "project.open";
  return {
    kind: "command",
    scope: future.has(id) ? "future" : existing ? "existing" : "p0-p3",
    effect: remoteWrite.has(id) || mayAutosave ? "remote-write" : id === "catalog.refresh" ? "read" : id.startsWith("ui.") || id === "project.exportOriginal" ? "ui-local" : "project-local",
    completion: reload.has(id) ? "page-reload" : frameJobs.has(id) ? "frame-committed" : "state-committed",
    ...(frameJobs.has(id) || id === "points.selectDataset" ? { execution: "job" as const, cancellationSupported: id !== "layer.remove" } : {}),
    ...(id === "points.selectDataset" ? { completionNote: "load=false only commits the selected dataset ID and returns frameConfirmed=false. load=true additionally waits for the installed point frame and returns frameConfirmed=true. This conditional operation emits state/job events; use points.load for frame.committed events." } : {}),
    ...(id === "raster.select" ? { completionNote: "The target visible or hidden state has rendered. Hidden selection does not load or commit the requested raster source; inspect selection.status and the raster state snapshot." } : {}),
    ...(mayAutosave ? { completionNote: frameJobs.has(id)
      ? "The native layer or removal frame is confirmed; an authenticated cloud project may schedule autosave. This result does not confirm cloud persistence. Failed additions retain an explicit error record for diagnosis/removal."
      : "Local state committed; an authenticated cloud project may schedule autosave. This result does not confirm cloud persistence." } : {}),
    requirements: ["registered-handler", "current-session-permissions", "current-runtime-capabilities"],
  };
}
