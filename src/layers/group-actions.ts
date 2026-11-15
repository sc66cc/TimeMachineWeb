import { AGENT_ACTIONS, AGENT_DECLARATIONS } from "../agent-actions/actions";
import { agentActions, AgentActionValidationError } from "../agent-actions/registry";
import { validateApiInput } from "../agent-actions/contracts";
import type { ProjectLayerGroupSnapshot, ProjectSession } from "../project/project-session";
import type { LayerController } from "./layer-controller";
import { layerGroupInputSchema } from "./group-action-schema";

export function registerLayerGroupActions(
  session: ProjectSession,
  controller: LayerController,
  guardMove?: (groupId: number, parentId?: number) => void,
): void {
  agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.layerGroupAdd], params => {
    const invalid = validateApiInput(layerGroupInputSchema, params.group);
    if (invalid) throw new AgentActionValidationError(invalid);
    const input = params.group as Omit<ProjectLayerGroupSnapshot, "id">;
    if (!input.name.trim()) throw new AgentActionValidationError("Group name must not be blank.");
    const groupId = controller.addGroup(input);
    return { data: { groupId, group: session.getGroup(groupId) } };
  });
  agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.layerGroupMove], params => {
    const groupId = params.groupId as number;
    const parentId = params.parentId as number | undefined;
    guardMove?.(groupId, parentId);
    controller.moveGroup(groupId, parentId);
    return { data: { groupId, group: session.getGroup(groupId) } };
  });
  agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.layerGroupRemove], params => {
    const groupId = params.groupId as number;
    controller.removeGroup(groupId);
    return { data: { groupId, removed: true } };
  });
}
