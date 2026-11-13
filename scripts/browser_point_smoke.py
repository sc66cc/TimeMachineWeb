#!/usr/bin/env python3
"""Functional browser smoke test for every local point-performance fixture.

Headless Chromium is suitable for catching WebGL/runtime regressions. Its FPS
is not a hardware-GPU benchmark and must not be used as the product threshold.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4173/"
DATASETS = (
    ("pbdb-10k", "10,000"),
    ("pbdb-100k", "100,000"),
    ("pbdb-275k", "275,000"),
    ("pbdb-real", "275,291"),
    ("pbdb-1m", "1,000,000"),
    ("pbdb-3m", "3,000,000"),
    ("pbdb-5m", "5,000,000"),
)


def main() -> None:
    errors: list[str] = []
    results: list[dict[str, str | float]] = []

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
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60_000)
        page.locator("#loading-overlay.is-complete").wait_for(
            state="attached",
            timeout=90_000,
        )
        page.locator("#point-dataset-select:enabled").wait_for(
            state="attached",
            timeout=30_000,
        )
        point_layer = page.locator(".layer-row", has=page.locator("#point-state-chip"))
        point_layer.click()
        page.locator("#point-dataset-select:visible").wait_for(
            state="visible",
            timeout=10_000,
        )

        webgl = page.evaluate(
            """() => {
              const canvas = document.querySelector('#cesium-container canvas');
              const gl = canvas?.getContext('webgl2');
              if (!gl) return { renderer: 'unavailable', version: 'unavailable' };
              const extension = gl.getExtension('WEBGL_debug_renderer_info');
              return {
                renderer: extension
                  ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
                  : gl.getParameter(gl.RENDERER),
                version: gl.getParameter(gl.VERSION),
              };
            }"""
        )

        for dataset_id, expected_count in DATASETS:
            page.click("#today-button")
            page.select_option("#point-dataset-select", dataset_id)
            started = time.perf_counter()
            page.click("#load-points")
            page.wait_for_function(
                """() => {
                  const chip = document.querySelector('#point-state-chip');
                  return chip?.textContent === '运行中' || chip?.textContent === '失败';
                }""",
                timeout=180_000,
            )
            state = page.locator("#point-state-chip").inner_text()
            status = page.locator("#point-status").inner_text()
            if state != "运行中":
                raise RuntimeError(f"{dataset_id} failed: {status}")
            actual_count = page.locator("#point-count").inner_text()
            if actual_count != expected_count:
                raise AssertionError(
                    f"{dataset_id}: expected {expected_count}, got {actual_count}"
                )
            wall_load_seconds = round(time.perf_counter() - started, 3)

            # Exercise changing quaternion uniforms without letting slow
            # software WebGL make real-time playback run far past the target.
            for age_ma in (95, 100, 105, 100):
                page.locator("#timeline-slider").evaluate(
                    """(slider, age) => {
                      slider.value = String(age);
                      slider.dispatchEvent(new Event('input', { bubbles: true }));
                    }""",
                    age_ma,
                )
                page.wait_for_timeout(250)
            results.append(
                {
                    "dataset": dataset_id,
                    "wallLoadSeconds": wall_load_seconds,
                    "count": actual_count,
                    "active": page.locator("#visible-point-count").inner_text(),
                    "fileGpu": page.locator("#point-memory").inner_text(),
                    "fetchUpload": page.locator("#point-load-time").inner_text(),
                    "fps": page.locator("#point-fps").inner_text(),
                    "frameP95": page.locator("#point-frame-p95").inner_text(),
                    "latency": page.locator("#point-latency").inner_text(),
                }
            )
            if results[-1]["active"] != expected_count:
                raise AssertionError(
                    f"{dataset_id}: expected {expected_count} resident points, "
                    f"got {results[-1]['active']}"
                )

        screenshot = Path("/tmp/webgplates-point-lab.png")
        page.screenshot(path=str(screenshot), full_page=True)
        browser.close()

    if errors:
        raise RuntimeError("Browser errors:\n" + "\n".join(errors))

    print(
        json.dumps(
            {
                "note": "Functional headless run; FPS is not a hardware benchmark.",
                "webgl": webgl,
                "datasets": results,
                "screenshot": str(screenshot),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
