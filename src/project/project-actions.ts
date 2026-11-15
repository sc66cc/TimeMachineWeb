import { AGENT_ACTIONS, AGENT_DECLARATIONS } from "../agent-actions/actions";
import { agentActions, AgentActionUnsupportedError } from "../agent-actions/registry";
import type { ProjectSession } from "./project-session";

export interface ProjectLocalActionPorts {
  storage: Pick<Storage, "getItem" | "setItem">;
  capture(): void;
  publish(): void;
  original?: string;
  reviewOriginal?(): string | undefined;
  downloadOriginal(original: string): void;
}

/** The UI action and autosave share the same capture and storage boundary. */
export function registerProjectLocalActions(session: ProjectSession | undefined, ports: ProjectLocalActionPorts) {
  const saveLocal = () => {
    if (!session || session.isReadOnly) throw new AgentActionUnsupportedError("This project is read-only. Review its compatibility report and original input.");
    try {
      ports.capture();
      const saved = session.save(ports.storage);
      return { savedAt: saved.savedAt, revision: session.localSaveState.savedRevision! };
    } finally { ports.publish(); }
  };
  agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.projectSaveLocal], () => ({ data: saveLocal() }));
  agentActions.setAvailability(AGENT_ACTIONS.projectSaveLocal, () => session && !session.isReadOnly
    ? undefined : "This project is read-only; review the compatibility report.");
  agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.projectExportOriginal], params => {
    const original = params.source === "review" ? ports.reviewOriginal?.() : ports.original;
    if (original === undefined) throw new AgentActionUnsupportedError("The requested project input is unavailable for export.");
    ports.downloadOriginal(original);
    return { data: { downloadStarted: true, bytes: new TextEncoder().encode(original).byteLength } };
  });
  agentActions.setAvailability(AGENT_ACTIONS.projectExportOriginal, () => ports.original === undefined && ports.reviewOriginal?.() === undefined
    ? "This project has no original input to export." : undefined);
  return { saveLocal };
}
