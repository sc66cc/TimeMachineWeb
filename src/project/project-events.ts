import type { ProjectCompatibilityReport, ProjectLocalSaveState, ProjectRestoreResult } from "./project-session";

export const PROJECT_STATE_EVENT = "timemachine:project-state";

export interface ProjectCloudSaveState {
  status: "idle" | "dirty" | "saving" | "saved" | "error" | "readonly";
  revision?: number;
  revisionId?: number;
  revisionNumber?: number;
  message?: string;
  remoteCommitted?: boolean;
}

export interface ProjectStateDetail {
  timeRange?: { minAgeMa: number; maxAgeMa: number };
  restoreStatus: ProjectRestoreResult["status"];
  compatibility: ProjectCompatibilityReport;
  localSave: ProjectLocalSaveState;
  cloudSave: ProjectCloudSaveState;
  originalAvailable: boolean;
  review?: { name: string; compatibility: ProjectCompatibilityReport; originalAvailable: boolean };
}
