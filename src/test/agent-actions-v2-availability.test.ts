// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { mountAppShell } from "./support/mount-app-shell";
import { agentActions, AGENT_ACTIONS } from "../agent-actions";

/**
 * V2 capability is discovered asynchronously, so this test holds the platform
 * handshake open and lets it resolve while the real AppShell is mounted: the
 * production handlers are registered once and their availability is evaluated
 * live. Nothing here registers a stand-in handler.
 *
 * The other two directions live elsewhere: a handshake that never succeeds
 * (V1-only) is pinned in `agent-actions-appshell.test.ts`, and a capability
 * that disappears again is pinned on the registry itself in
 * `agent-facade-security.test.ts`.
 */
const bootstrapGate = vi.hoisted(() => {
  let releaseBootstrap: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    releaseBootstrap = resolve;
  });
  return {
    entered,
    release: () => releaseBootstrap?.(),
  };
});

vi.mock("../platform-bootstrap", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../platform-bootstrap")>();
  return {
    ...actual,
    // Resolves only when the test releases it, so the handshake can be
    // observed in both states without touching a Server.
    bootstrapTimeMachinePlatform: async () => {
      await bootstrapGate.entered;
      return undefined;
    },
  };
});

/** Waits until the mounted AppShell's live availability settles. */
async function waitForV2(available: boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = agentActions
      .listActions()
      .find((action) => action.id === AGENT_ACTIONS.uploadOpen)?.status;
    if ((status === "ready") === available) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`V2 availability never became ${available}.`);
}

describe("V2 availability discovered after mount", () => {
  afterEach(() => {
    bootstrapGate.release();
  });

  it("keeps the real handlers and flips them from unsupported to ready", async () => {
    const mounted = await mountAppShell();
    try {
      const v2Actions = [
        AGENT_ACTIONS.datasetSelect,
        AGENT_ACTIONS.uploadOpen,
        AGENT_ACTIONS.uploadRun,
        AGENT_ACTIONS.uploadCancel,
      ];
      const inventory = new Map(
        agentActions.listActions().map((action) => [action.id, action.status]),
      );
      for (const id of v2Actions) {
        expect(inventory.get(id), id).toBe("unsupported");
      }
      expect(inventory.get(AGENT_ACTIONS.projectOpen)).toBe("unsupported");

      // The handshake resolves late, exactly like a slow Server.
      bootstrapGate.release();
      await waitForV2(true);

      for (const id of v2Actions) {
        const status = agentActions
          .listActions()
          .find((action) => action.id === id)?.status;
        expect(status, id).toBe("ready");
      }
      // Opening also persists the replacement project. main owns that handler;
      // the standalone shell keeps it unavailable after the Server handshake.
      expect(agentActions.listActions().find(action => action.id === AGENT_ACTIONS.projectOpen)?.status).toBe("unsupported");
      expect(await agentActions.execute(AGENT_ACTIONS.projectOpen, { revisionId: 1 }))
        .toMatchObject({ ok: false, error: { kind: "unsupported" } });

      // The registered production handlers now answer instead of a 501: the
      // upload entry now asks for authentication without claiming it opened,
      // cancelling
      // an idle wizard succeeds, and an ingest without a file is a validation
      // failure rather than "unsupported".
      const opened = await agentActions.execute(AGENT_ACTIONS.uploadOpen);
      expect(opened).toMatchObject({ ok: false, error: { kind: "auth" } });
      expect(agentActions.getState().ui).toMatchObject({
        authDialogOpen: true,
        uploadWizardOpen: false,
      });

      const cancelled = await agentActions.execute(AGENT_ACTIONS.uploadCancel);
      expect(cancelled.ok).toBe(true);

      const run = await agentActions.execute(AGENT_ACTIONS.uploadRun);
      expect(run.ok).toBe(false);
      if (!run.ok) {
        expect(run.error.kind).toBe("validation");
      }

      const dataset = await agentActions.execute(AGENT_ACTIONS.datasetSelect, {
        datasetVersionId: 7,
      });
      // Selecting a versioned dataset schedules the reload that adds it, so it
      // answers accepted rather than a 501.
      expect(dataset).toMatchObject({
        data: { accepted: true },
        ok: true,
        reloadRequired: true,
      });
    } finally {
      mounted.unmount();
    }
  });
});
