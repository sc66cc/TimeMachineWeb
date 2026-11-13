import {
  ImageryLayer,
  Rectangle,
  UrlTemplateImageryProvider,
  Viewer,
  WebMercatorTilingScheme,
} from "cesium";

import { SPHERICAL_EARTH } from "@timemachine/cesium-runtime";
import type {
  SingleRasterEntry,
  SingleRasterManifest,
  SingleRasterRuntimeState,
} from "./types";

export type SingleRasterStateListener = (
  state: SingleRasterRuntimeState,
) => void;

function rootTileUrl(raster: SingleRasterEntry): string {
  return raster.tileUrl
    .replace("{z}", "0")
    .replace("{x}", "0")
    .replace("{y}", "0");
}

export class SingleRasterLayerController {
  private currentRaster: SingleRasterEntry | undefined;
  private currentLayer: ImageryLayer | undefined;
  private switchGeneration = 0;
  private visible = true;
  private opacity = 0.9;

  constructor(
    private readonly viewer: Viewer,
    readonly manifest: SingleRasterManifest,
    private readonly onStateChange: SingleRasterStateListener,
  ) {}

  select(rasterId: string): void {
    const raster = this.manifest.rasters.find(
      (candidate) => candidate.id === rasterId,
    );
    if (!raster) {
      throw new Error(`SingleRaster dataset "${rasterId}" was not found.`);
    }
    if (raster.id === this.currentRaster?.id) {
      this.notifyCurrent();
      return;
    }
    void this.switchRaster(raster, ++this.switchGeneration);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.currentLayer) {
      this.currentLayer.show = visible;
    }
    this.notifyCurrent();
    this.viewer.scene.requestRender();
  }

  setOpacity(opacity: number): void {
    this.opacity = Math.max(0, Math.min(1, opacity));
    if (this.currentLayer) {
      this.currentLayer.alpha = this.opacity;
    }
    this.viewer.scene.requestRender();
  }

  raiseToTop(): void {
    if (
      this.currentLayer &&
      this.viewer.imageryLayers.contains(this.currentLayer)
    ) {
      this.viewer.imageryLayers.raiseToTop(this.currentLayer);
    }
  }

  destroy(): void {
    this.switchGeneration += 1;
    this.removeLayer(this.currentLayer);
    this.currentLayer = undefined;
    this.currentRaster = undefined;
  }

  private async switchRaster(
    raster: SingleRasterEntry,
    generation: number,
  ): Promise<void> {
    this.onStateChange({ status: "loading", raster });
    try {
      const response = await fetch(rootTileUrl(raster), {
        cache: "force-cache",
      });
      if (!response.ok) {
        throw new Error(`root tile HTTP ${response.status}`);
      }
      await response.blob();
      if (generation !== this.switchGeneration) {
        return;
      }

      const provider = new UrlTemplateImageryProvider({
        url: raster.tileUrl,
        credit: this.manifest.attribution,
        minimumLevel: raster.tiles.minimumLevel,
        maximumLevel: raster.tiles.maximumLevel,
        rectangle: Rectangle.fromDegrees(
          ...this.manifest.tileMatrixSet.bounds,
        ),
        tilingScheme: new WebMercatorTilingScheme({
          ellipsoid: SPHERICAL_EARTH,
        }),
        ellipsoid: SPHERICAL_EARTH,
        hasAlphaChannel: raster.tiles.hasAlphaChannel,
        enablePickFeatures: false,
      });
      const nextLayer = new ImageryLayer(provider, {
        alpha: this.opacity,
        show: this.visible,
      });
      this.viewer.imageryLayers.add(nextLayer);
      const previousLayer = this.currentLayer;
      this.currentLayer = nextLayer;
      this.currentRaster = raster;
      this.removeLayer(previousLayer);
      this.notifyCurrent();
      this.viewer.scene.requestRender();
    } catch (error) {
      if (generation !== this.switchGeneration) {
        return;
      }
      this.onStateChange({
        status: "error",
        raster,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private notifyCurrent(): void {
    if (!this.visible) {
      this.onStateChange({
        status: "hidden",
        raster: this.currentRaster,
      });
    } else if (this.currentRaster) {
      this.onStateChange({
        status: "ready",
        raster: this.currentRaster,
      });
    }
  }

  private removeLayer(layer: ImageryLayer | undefined): void {
    if (layer && this.viewer.imageryLayers.contains(layer)) {
      this.viewer.imageryLayers.remove(layer, true);
    }
  }
}
