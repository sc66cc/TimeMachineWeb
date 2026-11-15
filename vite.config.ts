/// <reference types="vitest/config" />

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import cesium from "vite-plugin-cesium";

const pointDataDirectory = resolve("data/generated/points");
const atlasDataDirectory = resolve("data/generated/paleoatlas");
const singleRasterDataDirectory = resolve("data/generated/single-raster");
const packageAliases = {
  "@timemachine/api-client": resolve(
    "packages/api-client/src/index.ts",
  ),
  "@timemachine/generated-api": resolve(
    "packages/generated-api/src/index.ts",
  ),
  "@timemachine/platform-runtime": resolve(
    "packages/platform-runtime/src/index.ts",
  ),
  "@timemachine/reconstruction-core": resolve(
    "packages/reconstruction-core/src/index.ts",
  ),
  "@timemachine/cesium-runtime": resolve(
    "packages/cesium-runtime/src/index.ts",
  ),
  "@timemachine/point-runtime": resolve(
    "packages/point-runtime/src/index.ts",
  ),
  "@timemachine/raster-runtime": resolve(
    "packages/raster-runtime/src/index.ts",
  ),
};

function pointDataMiddleware(
  server: Pick<ViteDevServer, "middlewares">,
): void {
  server.middlewares.use(async (request, response, next) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!requestUrl.pathname.startsWith("/point-data/")) {
      next();
      return;
    }

    const fileName = basename(requestUrl.pathname);
    if (
      fileName !== requestUrl.pathname.slice("/point-data/".length) ||
      !/^[a-z0-9-]+\.(?:json|wgp)$/i.test(fileName)
    ) {
      response.statusCode = 400;
      response.end("Invalid point-data path.");
      return;
    }

    const filePath = resolve(pointDataDirectory, fileName);
    try {
      const metadata = await stat(filePath);
      response.statusCode = 200;
      response.setHeader(
        "Content-Type",
        fileName.endsWith(".json")
          ? "application/json; charset=utf-8"
          : "application/octet-stream",
      );
      response.setHeader("Content-Length", metadata.size);
      response.setHeader("Cache-Control", "no-cache");
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(filePath).pipe(response);
    } catch {
      response.statusCode = 404;
      response.end(`Point fixture ${fileName} was not found.`);
    }
  });
}

function pointDataPlugin(): Plugin {
  return {
    name: "timemachine-web-point-data",
    configureServer: pointDataMiddleware,
    configurePreviewServer: pointDataMiddleware,
  };
}

function atlasDataMiddleware(
  server: Pick<ViteDevServer, "middlewares">,
): void {
  server.middlewares.use(async (request, response, next) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/atlas-data/manifest.json") {
      next();
      return;
    }

    const filePath = resolve(atlasDataDirectory, "manifest.json");
    try {
      const metadata = await stat(filePath);
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Content-Length", metadata.size);
      response.setHeader("Cache-Control", "no-cache");
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(filePath).pipe(response);
    } catch {
      response.statusCode = 404;
      response.end(
        "PaleoAtlas manifest was not found. Run npm run data:atlas.",
      );
    }
  });
}

function atlasDataPlugin(): Plugin {
  return {
    name: "timemachine-web-atlas-data",
    configureServer: atlasDataMiddleware,
    configurePreviewServer: atlasDataMiddleware,
  };
}

function singleRasterDataMiddleware(
  server: Pick<ViteDevServer, "middlewares">,
): void {
  server.middlewares.use(async (request, response, next) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/single-raster-data/manifest.json") {
      next();
      return;
    }

    const filePath = resolve(singleRasterDataDirectory, "manifest.json");
    try {
      const metadata = await stat(filePath);
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Content-Length", metadata.size);
      response.setHeader("Cache-Control", "no-cache");
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(filePath).pipe(response);
    } catch {
      response.statusCode = 404;
      response.end(
        "SingleRaster manifest was not found. Run npm run data:rasters.",
      );
    }
  });
}

function singleRasterDataPlugin(): Plugin {
  return {
    name: "timemachine-web-single-raster-data",
    configureServer: singleRasterDataMiddleware,
    configurePreviewServer: singleRasterDataMiddleware,
  };
}

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    cesium(),
    pointDataPlugin(),
    atlasDataPlugin(),
    singleRasterDataPlugin(),
  ],
  resolve: {
    alias: { ...packageAliases, "@": resolve("src") },
  },
  test: {
    include: ["src/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["DPlanet/**"],
  },
  // Only expose the two runtime plate-model files. Point/raster datasets under
  // data/ are intentionally not copied into every production build.
  publicDir: "data/PlateModelData",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/atlas-tiles": {
        target: "http://127.0.0.1:3002",
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/atlas-tiles": {
        target: "http://127.0.0.1:3002",
      },
    },
  },
});
