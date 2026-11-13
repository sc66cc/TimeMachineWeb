import type {
  ProjectLayerGroupSnapshot,
  ProjectLayerSnapshot,
} from "../project/project-session";
import type { PointStyleExpression } from "@timemachine/point-runtime";

export const LAYER_STATE_EVENT = "timemachine:layer-state";
export const LAYER_VISIBILITY_CHANGE_EVENT =
  "timemachine:layer-visibility-change";
export const LAYER_OPACITY_CHANGE_EVENT = "timemachine:layer-opacity-change";
export const LAYER_ORDER_CHANGE_EVENT = "timemachine:layer-order-change";
export const POINT_STYLE_CHANGE_EVENT = "timemachine:point-style-change";
export const LAYER_GROUP_COLLAPSE_CHANGE_EVENT =
  "timemachine:layer-group-collapse-change";
export const LAYER_GROUP_OPACITY_CHANGE_EVENT =
  "timemachine:layer-group-opacity-change";
export const LAYER_GROUP_VISIBILITY_CHANGE_EVENT =
  "timemachine:layer-group-visibility-change";

export interface LayerStateDetail {
  groups: ProjectLayerGroupSnapshot[];
  layers: ProjectLayerSnapshot[];
}

export interface LayerVisibilityChangeDetail {
  active: boolean;
  id: number;
}

export interface LayerOpacityChangeDetail {
  alpha: number;
  id: number;
}

export interface LayerOrderChangeDetail {
  groupIdByLayer: Record<number, number>;
  orderedIds: number[];
}

export interface PointStyleChangeDetail {
  id: number;
  style: PointStyleExpression;
}

export interface LayerGroupCollapseChangeDetail {
  collapsed: boolean;
  id: number;
}

export interface LayerGroupOpacityChangeDetail {
  alpha: number;
  id: number;
}

export interface LayerGroupVisibilityChangeDetail {
  active: boolean;
  id: number;
}
