// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { mountAppShell } from "./support/mount-app-shell";
import {
  agentActions,
  AGENT_ACTIONS,
  type AgentActionResult,
} from "../agent-actions";

/** Narrows a successful result so the payload can be asserted. */
function payloadOf(result: AgentActionResult): Record<string, unknown> {
  if (!result.ok) {
    throw new Error(`Expected a success, got ${JSON.stringify(result)}`);
  }
  return result.data ?? {};
}

/**
 * These tests mount the real AppShell and drive the handlers the UI registers,
 * so they exercise the production registration path rather than a stand-in.
 * No real account, password, token or Server is involved.
 */

/** Actions with no button of their own: the programmatic form of a gesture. */
const GESTURE_ONLY_ACTIONS = new Set([
  AGENT_ACTIONS.accountMenuSetVisible,
  AGENT_ACTIONS.authDialogOpen,
  AGENT_ACTIONS.layerMoveToGroup,
  AGENT_ACTIONS.layerOrder,
]);

describe("mounted AppShell action facade", () => {
  it("reports V2-only actions as unsupported on a V1 Server", async () => {
    const mounted = await mountAppShell();
    try {
      const inventory = new Map(
        agentActions.listActions().map((action) => [action.id, action.status]),
      );
      for (const id of [
        AGENT_ACTIONS.datasetSelect,
        AGENT_ACTIONS.projectOpen,
        AGENT_ACTIONS.projectSave,
        AGENT_ACTIONS.uploadCancel,
        AGENT_ACTIONS.uploadOpen,
        AGENT_ACTIONS.uploadRun,
      ]) {
        expect(inventory.get(id), id).toBe("unsupported");
        const result = await agentActions.execute(id, { revisionId: 1 });
        expect(result.ok, id).toBe(false);
        if (!result.ok) {
          expect(result.error.kind, id).toBe("unsupported");
          expect(result.error.code, id).toBe(501);
        }
      }
    } finally {
      mounted.unmount();
    }
  });

  it("reports a failed catalog refresh as a failure, not a success", async () => {
    const mounted = await mountAppShell();
    try {
      const result = await agentActions.execute(AGENT_ACTIONS.catalogRefresh);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // A failed request is an execution failure, not a caller parameter
        // error, so it must not be filed as a 400 validation error.
        expect(result.error.kind).not.toBe("unsupported");
        expect(result.error.kind).toBe("internal");
        expect(result.error.code).toBe(500);
      }
    } finally {
      mounted.unmount();
    }
  });

  it("rejects an invalid enum instead of silently defaulting", async () => {
    const mounted = await mountAppShell();
    try {
      const cases: [string, Record<string, unknown>][] = [
        [AGENT_ACTIONS.sidebarSelect, { tab: "nope" }],
        [AGENT_ACTIONS.authModeSet, { mode: "sms" }],
        [AGENT_ACTIONS.moduleSelect, { module: "Teleporter" }],
        [AGENT_ACTIONS.modelSelect, { source: "cloud" }],
        [AGENT_ACTIONS.authLogin, { mode: "sms" }],
        [AGENT_ACTIONS.authLogin, { mode: "account", account: "a" }],
      ];
      for (const [id, params] of cases) {
        const result = await agentActions.execute(id, params);
        expect(result.ok, id).toBe(false);
        if (!result.ok) {
          expect(result.error.kind, id).toBe("validation");
          expect(result.error.code, id).toBe(400);
        }
      }
    } finally {
      mounted.unmount();
    }
  });

  it("keeps any point size the action accepts on the size range control", async () => {
    const mounted = await mountAppShell();
    try {
      const range = document.querySelector<HTMLInputElement>("#point-size");
      expect(range).not.toBeNull();
      // The action contract accepts any finite value in 0.5..8, so a fixed step
      // would be wrong: it snaps 4 to 4.1 and cannot represent 8 exactly.
      expect(range?.step).toBe("any");
      for (const pointSize of ["4", "3.75", "8"]) {
        if (range) {
          range.value = pointSize;
        }
        expect(range?.value, pointSize).toBe(pointSize);
      }
    } finally {
      mounted.unmount();
    }
  });

  it("reports a V2 model selection as unsupported on a V1 Server", async () => {
    const mounted = await mountAppShell();
    try {
      const result = await agentActions.execute(AGENT_ACTIONS.modelSelect, {
        source: "v2",
        versionId: 9,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("unsupported");
      }
    } finally {
      mounted.unmount();
    }
  });

  it("drives the pure UI controls through the registered handlers", async () => {
    const mounted = await mountAppShell();
    try {
      // The sign-in button opens the dialog when signed out.
      const toggled = await agentActions.execute(
        AGENT_ACTIONS.accountMenuToggle,
      );
      expect(toggled.ok).toBe(true);
      expect(payloadOf(toggled)).toEqual({
        accountMenuOpen: false,
        authDialogOpen: true,
      });

      const closed = await agentActions.execute(AGENT_ACTIONS.authDialogClose);
      expect(closed.ok).toBe(true);

      const tab = await agentActions.execute(AGENT_ACTIONS.sidebarSelect, {
        tab: "plate-models",
      });
      expect(payloadOf(tab)).toEqual({ tab: "plate-models" });

      const style = await agentActions.execute(AGENT_ACTIONS.layerStyleOpen, {
        layerId: 3,
      });
      expect(payloadOf(style)).toEqual({ layerId: 3 });

      const search = await agentActions.execute(AGENT_ACTIONS.layerSearchSet, {
        query: "raster",
      });
      expect(payloadOf(search)).toEqual({ query: "raster" });

      const module = await agentActions.execute(AGENT_ACTIONS.moduleSelect, {
        module: "Atlas",
      });
      expect(payloadOf(module)).toEqual({ module: "Atlas" });

      const toolbar = await agentActions.execute(AGENT_ACTIONS.toolbarToggle);
      expect(payloadOf(toolbar)).toEqual({ collapsed: true });

      const back = await agentActions.execute(AGENT_ACTIONS.uploadBack, {
        step: "map",
      });
      expect(payloadOf(back)).toEqual({ step: "map" });

      const closeUpload = await agentActions.execute(AGENT_ACTIONS.uploadClose);
      expect(closeUpload.ok).toBe(true);
    } finally {
      mounted.unmount();
    }
  });

  it("never exposes a credential through getState", async () => {
    const mounted = await mountAppShell();
    try {
      const serialized = JSON.stringify(agentActions.getState());
      expect(serialized).not.toMatch(/"token"/i);
      expect(serialized).not.toMatch(/"password"/i);
      expect(serialized).not.toMatch(/"digest"/i);
      expect(serialized).not.toMatch(/fixture-secret/);
    } finally {
      mounted.unmount();
    }
  });

  it("redacts a credential carried by a real cloud error string", async () => {
    // The real path: the offline fetch fails with a message that contains a
    // labelled credential, the real cloud client stores that message as
    // `sharedPlateModelsError`, and the real `catalog` provider returns it.
    const mounted = await mountAppShell({
      fetchErrorMessage:
        "Shared plate model request failed: token=fixture-secret",
    });
    try {
      await agentActions.execute(AGENT_ACTIONS.catalogRefresh);
      const serialized = JSON.stringify(agentActions.getState());
      expect(serialized).not.toContain("fixture-secret");
      const catalog = agentActions.getState().catalog as {
        error: string;
      };
      expect(catalog.error).toContain("token=[redacted]");
      // Ordinary text in the same message survives.
      expect(catalog.error).toContain("Shared plate model request failed");
    } finally {
      mounted.unmount();
    }
  });

  it("reports a failed auth.sendCode as a failure, not a success", async () => {
    const mounted = await mountAppShell();
    try {
      const result = await agentActions.execute(AGENT_ACTIONS.authSendCode, {
        email: "agent@example.com",
      });
      // The handler awaits the real request, so the offline environment has to
      // come back as a failure rather than "code sent".
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).not.toBe("unsupported");
      }
    } finally {
      mounted.unmount();
    }
  });

  it("keeps a failing UI dispatch from producing an unhandled rejection", async () => {
    const mounted = await mountAppShell();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      // Drive the real button the way a user would: open the dialog, switch to
      // the email-code mode, fill the email, click Send code.
      await agentActions.execute(AGENT_ACTIONS.authDialogOpen);
      await agentActions.execute(AGENT_ACTIONS.authModeSet, {
        mode: "email-code",
      });
      const email = document.querySelector<HTMLInputElement>(
        'input[data-action="auth.sendCode"]',
      );
      const send = document.querySelector<HTMLButtonElement>(
        'button[data-action="auth.sendCode"]',
      );
      expect(email).not.toBeNull();
      expect(send).not.toBeNull();
      if (!email || !send) {
        return;
      }
      email.value = "ui@example.com";
      email.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rejections).toEqual([]);
      // The same business function answers the facade, so it failed too.
      const result = await agentActions.execute(AGENT_ACTIONS.authSendCode, {
        email: "ui@example.com",
      });
      expect(result.ok).toBe(false);
    } finally {
      process.off("unhandledRejection", onRejection);
      mounted.unmount();
    }
  });
});

describe("control coverage audit", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/AppShell.vue"),
    "utf-8",
  );
  const declared = new Set(
    Object.values(AGENT_ACTIONS) as readonly string[],
  );
  const buttonTags = [...source.matchAll(/<button\b[^>]*>/g)].map(
    (match) => match[0],
  );
  const boundActions = [
    ...new Set(
      [...source.matchAll(/data-action="([\w.\-]+)"/g)].map(
        (match) => match[1] as string,
      ),
    ),
  ];

  it("binds every button in the template to an action", () => {
    const unbound = buttonTags.filter((tag) => !tag.includes("data-action"));
    expect(unbound).toEqual([]);
    expect(buttonTags.length).toBeGreaterThan(40);
  });

  it("only references declared action ids from the template", () => {
    expect(boundActions.filter((id) => !declared.has(id))).toEqual([]);
  });

  it("accounts for every declared action id", () => {
    const unbound = [...declared].filter(
      (id) =>
        !boundActions.includes(id) &&
        !(GESTURE_ONLY_ACTIONS as ReadonlySet<string>).has(id),
    );
    expect(unbound).toEqual([]);
  });
});
