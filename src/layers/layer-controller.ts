import type { PointStyleExpression } from "@timemachine/point-runtime";
import type { NativeLineStyle } from "./native-line-style";
import type { NativePolygonStyle } from "./native-polygon-style";

import {
  AgentActionValidationError,
} from "../agent-actions/registry";
import type { ProjectLayerGroupSnapshot, ProjectSession } from "../project/project-session";

/**
 * The renderer side of a layer edit. Implemented by `main.ts`, which owns the
 * Cesium viewer, the imagery controllers and the native sidebar controls.
 */
export interface LayerRuntimeAdapter {
  /** Re-applies atlas/raster stacking order after a reorder. */
  applyImageryOrder(): void;
  /** Pushes one layer's effective visibility/opacity into its renderer. */
  applyRuntime(id: number): void;
  /** Captures, persists and schedules the cloud autosave for this edit. */
  persist(): void;
  /** Publishes the new layer/group state to the sidebar. */
  publishState(): void;
  /** Mirrors the new state onto the native checkboxes and range inputs. */
  syncNativeControls(): void;
}

/**
 * The single place where a layer edit is applied.
 *
 * Both the sidebar UI (through `layers/layer-events` window events) and the
 * action facade call these methods, so a layer change means exactly the same
 * thing whichever entry point produced it: the project session is updated, the
 * native controls are synced, every affected renderer is updated, the imagery
 * order is fixed when needed, the sidebar state is republished and the edit is
 * persisted.
 */
export class LayerController {
  constructor(
    private readonly session: ProjectSession,
    private readonly runtime: LayerRuntimeAdapter,
  ) {}

  addGroup(input: Omit<ProjectLayerGroupSnapshot, "id">): number {
    let id: number;
    try { id = this.session.addGroup(input); }
    catch (error) { throw new AgentActionValidationError(error instanceof Error ? error.message : "Invalid group."); }
    this.runtime.publishState();
    this.runtime.persist();
    return id;
  }

  moveGroup(id: number, parentId?: number): void {
    this.requireGroup(id);
    if (parentId !== undefined) this.requireGroup(parentId);
    try { this.session.moveGroup(id, parentId); }
    catch (error) { throw new AgentActionValidationError(error instanceof Error ? error.message : "Invalid group move."); }
    this.runtime.syncNativeControls();
    this.applyGroupMembers(id);
    this.runtime.publishState();
    this.runtime.persist();
  }

  removeGroup(id: number): void {
    this.requireGroup(id);
    try { this.session.removeGroup(id); }
    catch (error) { throw new AgentActionValidationError(error instanceof Error ? error.message : "Cannot remove group."); }
    this.runtime.publishState();
    this.runtime.persist();
  }

  setLayerVisibility(id: number, active: boolean): void {
    this.requireLayer(id);
    this.session.setLayerVisibility(id, active);
    this.runtime.syncNativeControls();
    this.runtime.applyRuntime(id);
    this.runtime.publishState();
    this.runtime.persist();
  }

  setLayerOpacity(id: number, alpha: number): void {
    this.requireLayer(id);
    this.requireAlpha(alpha);
    this.session.setLayerOpacity(id, alpha);
    this.runtime.syncNativeControls();
    this.runtime.applyRuntime(id);
    this.runtime.publishState();
    this.runtime.persist();
  }

  /** Group visibility/opacity apply to every member layer, not to a renderer. */
  setGroupVisibility(id: number, active: boolean): void {
    this.requireGroup(id);
    this.session.setGroupVisibility(id, active);
    this.applyGroupMembers(id);
    this.runtime.publishState();
    this.runtime.persist();
  }

  setGroupOpacity(id: number, alpha: number): void {
    this.requireGroup(id);
    this.requireAlpha(alpha);
    this.session.setGroupOpacity(id, alpha);
    this.applyGroupMembers(id);
    this.runtime.publishState();
    this.runtime.persist();
  }

  setGroupCollapsed(id: number, collapsed: boolean): void {
    this.requireGroup(id);
    this.session.setGroupCollapsed(id, collapsed);
    this.runtime.publishState();
    this.runtime.persist();
  }

  setLayerGroup(id: number, groupId: number): void {
    this.requireLayer(id);
    this.requireGroup(groupId);
    this.session.setLayerGroup(id, groupId);
    this.runtime.applyRuntime(id);
    this.runtime.applyImageryOrder();
    this.runtime.publishState();
    this.runtime.persist();
  }

  /**
   * Reorders every layer and optionally moves layers between groups, matching
   * what a drag-and-drop in the sidebar produces.
   */
  setOrder(
    orderedIds: readonly number[],
    groupIdByLayer?: Record<string, number> | Record<number, number>,
  ): void {
    for (const id of orderedIds) {
      this.requireLayer(id);
    }
    if (groupIdByLayer) {
      for (const [layerKey, groupId] of Object.entries(groupIdByLayer)) {
        const layerId = Number(layerKey);
        this.requireLayer(layerId);
        this.requireGroup(Number(groupId));
      }
    }
    this.session.reorderLayers(orderedIds);
    if (groupIdByLayer) {
      for (const [layerKey, groupId] of Object.entries(groupIdByLayer)) {
        this.session.setLayerGroup(Number(layerKey), Number(groupId));
      }
    }
    for (const id of orderedIds) {
      this.runtime.applyRuntime(id);
    }
    this.runtime.applyImageryOrder();
    this.runtime.publishState();
    this.runtime.persist();
  }

  setPointStyle(id: number, style: PointStyleExpression): void {
    this.requireLayer(id);
    const previous = this.session.getLayer(id)!.pointStyle;
    this.commitStyleEdit(id,
      () => this.session.setPointStyle(id, style),
      () => this.session.setPointStyle(id, previous));
  }

  setLineStyle(id: number, style: NativeLineStyle): void {
    this.requireLayer(id);
    const previous = this.session.getLayer(id)!.lineStyle;
    this.commitStyleEdit(id,
      () => this.session.setLineStyle(id, style),
      () => this.session.setLineStyle(id, previous));
  }

  setPolygonStyle(id: number, style: NativePolygonStyle): void {
    this.requireLayer(id);
    const previous = this.session.getLayer(id)!.polygonStyle;
    this.commitStyleEdit(id,
      () => this.session.setPolygonStyle(id, style),
      () => this.session.setPolygonStyle(id, previous));
  }

  /** A failed native style application must not leave a different hidden draft. */
  private commitStyleEdit(id: number, write: () => void, restore: () => void): void {
    write();
    try {
      this.runtime.syncNativeControls();
      this.runtime.applyRuntime(id);
    } catch (error) {
      const errors = [error];
      try { restore(); } catch (failure) { errors.push(failure); }
      try { this.runtime.syncNativeControls(); } catch (failure) { errors.push(failure); }
      try { this.runtime.applyRuntime(id); } catch (failure) { errors.push(failure); }
      // Publish the authoritative business value even when native recovery failed.
      try { this.runtime.publishState(); } catch (failure) { errors.push(failure); }
      if (errors.length > 1) throw new AggregateError(errors, "Layer style application and recovery failed.");
      throw error;
    }
    this.runtime.publishState();
    this.runtime.persist();
  }

  private applyGroupMembers(id: number): void {
    for (const layerId of this.session.getGroupLayerIds(id)) {
      this.runtime.applyRuntime(layerId);
    }
  }

  private requireLayer(id: number): void {
    if (!this.session.getLayer(id)) {
      throw new AgentActionValidationError(`Unknown layer ${id}.`);
    }
  }

  private requireGroup(id: number): void {
    if (!this.session.getGroup(id)) {
      throw new AgentActionValidationError(`Unknown layer group ${id}.`);
    }
  }

  private requireAlpha(alpha: number): void {
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
      throw new AgentActionValidationError(
        `alpha must be within [0, 1]; received ${alpha}.`,
      );
    }
  }
}
