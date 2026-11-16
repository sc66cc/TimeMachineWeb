import { nextTick } from "vue";

import { AGENT_ACTIONS, agentActions } from "../../agent-actions";

/** The six kinds `ui.addPanel.setVisible` accepts. */
type AddLayerKind = "group" | "point" | "line" | "polygon" | "raster" | "atlas";

/**
 * Opens the add-layer panel on the requested kind through the same public
 * action a caller uses. Inactive `TabsContent` forms are intentionally not
 * force-mounted, so a test that drives one must select it first instead of
 * assuming every form is in the DOM.
 */
export async function openAddLayerPanel(kind: AddLayerKind): Promise<void> {
  const result = await agentActions.execute(AGENT_ACTIONS.addPanelSetVisible, {
    visible: true,
    kind,
  });
  if (!result.ok) {
    throw new Error(`Could not open the ${kind} add panel: ${result.error.message}`);
  }
  await nextTick();
  await nextTick();
}
