#!/usr/bin/env python3.12
"""Headless interaction test for all PaleoAtlas source frames and 5 Ma nodes."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5174/"
TIMELINE_STEP_MA = 5


def set_age(page: Page, age_ma: int) -> None:
    page.locator("#timeline-slider").evaluate(
        """(slider, age) => {
          slider.value = String(age);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
        }""",
        age_ma,
    )


def wait_for_frame(page: Page, age_ma: int) -> None:
    page.wait_for_function(
        """(age) => {
          const status = document.querySelector('#atlas-status');
          const frame = document.querySelector('#atlas-frame-value');
          return status?.dataset.state === 'ready' &&
            frame?.textContent?.trim() === `${age} Ma`;
        }""",
        arg=age_ma,
        timeout=30_000,
    )


def nearest_frame_age(frame_ages: list[int], age_ma: int) -> int:
    return min(frame_ages, key=lambda frame_age: (abs(age_ma - frame_age), frame_age))


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
            if "/atlas-tiles/paleoatlas_" in url:
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
              const response = await fetch('/atlas-data/manifest.json');
              if (!response.ok) {
                throw new Error(`manifest HTTP ${response.status}`);
              }
              return response.json();
            }""",
        )
        manifest_frames = sorted(
            manifest["frames"],
            key=lambda frame: int(frame["timeMa"]),
        )
        frame_ages = [int(frame["timeMa"]) for frame in manifest_frames]
        if len(frame_ages) != 90:
            raise RuntimeError(
                f"Expected 90 source frames, found {len(frame_ages)}.",
            )
        if len(frame_ages) != len(set(frame_ages)):
            raise RuntimeError("Manifest contains duplicate source ages.")
        timeline_step_ma = int(manifest.get("timelineStepMa", TIMELINE_STEP_MA))
        if timeline_step_ma != TIMELINE_STEP_MA:
            raise RuntimeError(
                f"Expected a {TIMELINE_STEP_MA} Ma timeline step, "
                f"found {timeline_step_ma}.",
            )

        observed_frames: list[int] = []
        for index, age_ma in enumerate(frame_ages, start=1):
            print(
                f"[source frame {index:02d}/{len(frame_ages)}] {age_ma} Ma",
                flush=True,
            )
            set_age(page, age_ma)
            try:
                wait_for_frame(page, age_ma)
            except Exception:
                debug_screenshot = Path(
                    f"/private/tmp/webgplates-paleoatlas-failed-{age_ma}.png",
                )
                page.screenshot(path=str(debug_screenshot), full_page=True)
                print(
                    json.dumps(
                        {
                            "ageMa": age_ma,
                            "frame": page.locator("#atlas-frame-value").inner_text(),
                            "statusState": page.locator("#atlas-status").get_attribute(
                                "data-state",
                            ),
                            "statusText": page.locator("#atlas-status").inner_text(),
                            "errors": errors,
                            "screenshot": str(debug_screenshot),
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                    flush=True,
                )
                raise
            observed_frames.append(age_ma)

        timeline_nodes = list(
            range(frame_ages[0], frame_ages[-1] + 1, TIMELINE_STEP_MA),
        )
        observed_timeline_frames: list[int] = []
        for index, age_ma in enumerate(timeline_nodes, start=1):
            expected_age_ma = nearest_frame_age(frame_ages, age_ma)
            if index == 1 or index % 15 == 0 or index == len(timeline_nodes):
                print(
                    f"[5 Ma node {index:03d}/{len(timeline_nodes)}] "
                    f"{age_ma} Ma -> {expected_age_ma} Ma",
                    flush=True,
                )
            set_age(page, age_ma)
            wait_for_frame(page, expected_age_ma)
            observed_timeline_frames.append(expected_age_ma)

        out_of_range_age = frame_ages[-1] + TIMELINE_STEP_MA
        set_age(page, out_of_range_age)
        page.wait_for_function(
            """() => {
              const status = document.querySelector('#atlas-status');
              const frame = document.querySelector('#atlas-frame-value');
              return status?.dataset.state === 'hidden' &&
                frame?.textContent?.trim() === '—';
            }""",
            timeout=10_000,
        )

        visibility_test_age = 300
        set_age(page, visibility_test_age)
        wait_for_frame(page, visibility_test_age)
        page.locator("#atlas-visibility").uncheck()
        page.wait_for_function(
            """() => document.querySelector('#atlas-status')?.dataset.state === 'hidden'""",
        )
        page.locator("#atlas-visibility").check()
        wait_for_frame(page, visibility_test_age)

        set_age(page, frame_ages[0])
        wait_for_frame(page, frame_ages[0])
        page.locator("#plate-visibility").uncheck()
        page.wait_for_timeout(600)
        screenshot = Path("/private/tmp/timemachine-paleoatlas-all-frames.png")
        page.screenshot(path=str(screenshot), full_page=True)
        browser.close()

    failed_tiles = {
        url: status for url, status in tile_responses.items() if status != 200
    }
    requested_sources = {
        url.split("/atlas-tiles/", 1)[1].split("/", 1)[0]
        for url in tile_responses
        if "/atlas-tiles/" in url
    }
    expected_sources = {str(frame["sourceId"]) for frame in manifest_frames}
    if failed_tiles:
        raise RuntimeError(f"Non-200 atlas tiles: {failed_tiles}")
    if not expected_sources.issubset(requested_sources):
        raise RuntimeError(
            f"Missing tile requests for {sorted(expected_sources - requested_sources)}",
        )
    if errors:
        raise RuntimeError("Browser errors:\n" + "\n".join(errors))

    print(
        json.dumps(
            {
                "sourceFrameCount": len(observed_frames),
                "sourceAgeRangeMa": [frame_ages[0], frame_ages[-1]],
                "sourceAgesMa": observed_frames,
                "fiveMaNodeCount": len(timeline_nodes),
                "fiveMaSelectionCount": len(observed_timeline_frames),
                "outOfRangeAgeMa": out_of_range_age,
                "outOfRangeResult": "hidden",
                "tileSourceCount": len(requested_sources),
                "tileRequestCount": len(tile_responses),
                "screenshot": str(screenshot),
            },
            ensure_ascii=False,
            indent=2,
        ),
    )


if __name__ == "__main__":
    main()
