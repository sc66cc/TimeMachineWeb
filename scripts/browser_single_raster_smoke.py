#!/usr/bin/env python3.12
"""Headless interaction test for SingleRaster colorbar layers."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5174/"


def select_raster(page: Page, raster_id: str) -> None:
    page.locator("#single-raster-select").select_option(raster_id)
    page.wait_for_function(
        """(rasterId) => {
          const status = document.querySelector('#single-raster-status');
          return status?.dataset.state === 'ready' &&
            status?.dataset.rasterId === rasterId;
        }""",
        arg=raster_id,
        timeout=30_000,
    )


def set_opacity(page: Page, opacity: float) -> None:
    page.locator("#single-raster-opacity").evaluate(
        """(slider, value) => {
          slider.value = String(value);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
        }""",
        opacity,
    )


def main() -> None:
    errors: list[str] = []
    tile_responses: dict[str, int] = {}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        page.on(
            "console",
            lambda message: errors.append(f"console.{message.type}: {message.text}")
            if message.type == "error"
            else None,
        )
        page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))

        def collect_tile_response(response: object) -> None:
            url = getattr(response, "url", "")
            if "/atlas-tiles/single_raster_" in url:
                tile_responses[url] = int(getattr(response, "status", 0))

        page.on("response", collect_tile_response)
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_load_state("networkidle", timeout=90_000)
        page.locator("#loading-overlay.is-complete").wait_for(
            state="attached",
            timeout=90_000,
        )

        manifest = page.evaluate(
            """async () => {
              const response = await fetch('/single-raster-data/manifest.json');
              if (!response.ok) {
                throw new Error(`manifest HTTP ${response.status}`);
              }
              return response.json();
            }""",
        )
        rasters = manifest["rasters"]
        if len(rasters) != 9:
            raise RuntimeError(f"Expected 9 rasters, found {len(rasters)}.")

        observed_ids: list[str] = []
        for index, raster in enumerate(rasters, start=1):
            raster_id = str(raster["id"])
            print(f"[raster {index}/9] {raster_id}", flush=True)
            select_raster(page, raster_id)
            legend_hidden = page.locator("#single-raster-legend").get_attribute(
                "hidden",
            )
            if raster["colorbar"] is None and legend_hidden is None:
                raise RuntimeError(f"{raster_id} should not show a colorbar.")
            if raster["colorbar"] is not None and legend_hidden is not None:
                raise RuntimeError(f"{raster_id} colorbar is hidden.")
            observed_ids.append(raster_id)

        set_opacity(page, 0.55)
        page.wait_for_function(
            """() =>
              document.querySelector('#single-raster-opacity-value')
                ?.textContent?.trim() === '55%'""",
        )

        visibility = page.locator("#single-raster-visibility")
        visibility.uncheck()
        page.wait_for_function(
            """() =>
              document.querySelector('#single-raster-status')
                ?.dataset.state === 'hidden'""",
        )
        visibility.check()
        select_raster(page, "seafloor_age_gts2012_000")

        page.locator("#atlas-visibility").uncheck()
        page.locator("#plate-visibility").uncheck()
        set_opacity(page, 0.9)
        page.wait_for_timeout(1_000)
        screenshot = Path("/private/tmp/timemachine-single-raster-colorbar.png")
        page.screenshot(path=str(screenshot), full_page=True)
        browser.close()

    failed_tiles = {
        url: status
        for url, status in tile_responses.items()
        if status not in {200, 204}
    }
    requested_sources = {
        url.split("/atlas-tiles/", 1)[1].split("/", 1)[0]
        for url in tile_responses
    }
    expected_sources = {str(raster["sourceId"]) for raster in rasters}
    if failed_tiles:
        raise RuntimeError(f"Non-200 SingleRaster tiles: {failed_tiles}")
    if not expected_sources.issubset(requested_sources):
        raise RuntimeError(
            f"Missing tile sources: {sorted(expected_sources - requested_sources)}",
        )
    if errors:
        raise RuntimeError("Browser errors:\n" + "\n".join(errors))

    print(
        json.dumps(
            {
                "rasterCount": len(observed_ids),
                "observedRasterIds": observed_ids,
                "colorbarCount": sum(
                    raster["colorbar"] is not None for raster in rasters
                ),
                "tileSourceCount": len(requested_sources),
                "tileRequestCount": len(tile_responses),
                "transparentEmptyTileCount": sum(
                    status == 204 for status in tile_responses.values()
                ),
                "visibilityToggle": "passed",
                "opacityAt55Percent": "passed",
                "screenshot": str(screenshot),
            },
            ensure_ascii=False,
            indent=2,
        ),
    )


if __name__ == "__main__":
    main()
