#!/usr/bin/env python3
"""Build PALEOMAP raster tiles served by Martin.

The source JPEGs are registered as a global EPSG:4326 raster with bounds
[-180, -90, 180, 90], warped to Web Mercator, and stored as JPEG MBTiles.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path


MVP_AGES_MA = (0, 100, 200, 300, 400, 500, 600, 750)
WEB_MERCATOR_LIMIT = 20_037_508.342789244
ZOOM_4_RESOLUTION = 9_783.93962050256
DEFAULT_JPEG_QUALITY = 95
DEFAULT_TIMELINE_STEP_MA = 5


def parse_args() -> argparse.Namespace:
    project_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(
        description="Generate PALEOMAP MBTiles frames and a runtime manifest.",
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=project_root
        / "data"
        / "TimeSequenceAtlas"
        / "PALEOMAP PaleoAtlas Rasters v3",
        help="Directory containing the PALEOMAP *_NNN.jpg frames.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Directory for generated MBTiles and manifest.json.",
    )
    parser.add_argument(
        "--all-frames",
        action="store_true",
        help="Build every source JPG instead of the eight-frame MVP subset.",
    )
    parser.add_argument(
        "--quality",
        type=int,
        default=DEFAULT_JPEG_QUALITY,
        help="JPEG quality for generated MBTiles (1-100; default: 95).",
    )
    parser.add_argument(
        "--timeline-step-ma",
        type=int,
        default=DEFAULT_TIMELINE_STEP_MA,
        help="Timeline validation interval recorded in the manifest.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Rebuild frames even when the MBTiles output is newer than its source.",
    )
    args = parser.parse_args()
    if not 1 <= args.quality <= 100:
        parser.error("--quality must be between 1 and 100.")
    if args.timeline_step_ma <= 0:
        parser.error("--timeline-step-ma must be greater than zero.")
    if args.output is None:
        output_name = "paleoatlas" if args.all_frames else "paleoatlas-mvp"
        args.output = project_root / "data" / "generated" / output_name
    return args


def require_tool(name: str) -> str:
    executable = shutil.which(name)
    if not executable:
        raise SystemExit(f"{name} is required but was not found on PATH.")
    return executable


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def discover_sources(source_directory: Path) -> dict[int, Path]:
    sources: dict[int, Path] = {}
    for source in sorted(source_directory.glob("*.jpg")):
        match = re.search(r"_(\d+)\.jpg$", source.name, re.IGNORECASE)
        if match is None:
            continue
        age_ma = int(match.group(1))
        if age_ma in sources:
            raise SystemExit(
                f"Duplicate source age {age_ma} Ma: "
                f"{sources[age_ma].name}, {source.name}",
            )
        sources[age_ma] = source
    if not sources:
        raise SystemExit(f"No *_NNN.jpg frames were found in {source_directory}.")
    return sources


def build_frame(
    source: Path,
    output: Path,
    *,
    gdal_translate: str,
    gdalwarp: str,
    gdaladdo: str,
    jpeg_quality: int,
) -> None:
    with tempfile.TemporaryDirectory(prefix="paleoatlas-", dir=output.parent) as temp:
        vrt = Path(temp) / f"{output.stem}.vrt"
        run(
            [
                gdal_translate,
                "-q",
                "-of",
                "VRT",
                "-a_srs",
                "EPSG:4326",
                "-a_ullr",
                "-180",
                "90",
                "180",
                "-90",
                str(source),
                str(vrt),
            ],
        )

        temporary_mbtiles = Path(temp) / output.name
        limit = f"{WEB_MERCATOR_LIMIT:.15f}"
        resolution = f"{ZOOM_4_RESOLUTION:.15f}"
        run(
            [
                gdalwarp,
                "-q",
                "-overwrite",
                "-multi",
                "-wo",
                "NUM_THREADS=ALL_CPUS",
                "-t_srs",
                "EPSG:3857",
                "-te",
                f"-{limit}",
                f"-{limit}",
                limit,
                limit,
                "-te_srs",
                "EPSG:3857",
                "-tr",
                resolution,
                resolution,
                "-r",
                "bilinear",
                "-of",
                "MBTILES",
                "-co",
                "TILE_FORMAT=JPEG",
                "-co",
                f"QUALITY={jpeg_quality}",
                str(vrt),
                str(temporary_mbtiles),
            ],
        )
        run(
            [
                gdaladdo,
                "-q",
                "-r",
                "average",
                str(temporary_mbtiles),
                "2",
                "4",
                "8",
                "16",
            ],
        )
        temporary_mbtiles.replace(output)


def main() -> None:
    args = parse_args()
    source_directory = args.source.resolve()
    output_directory = args.output.resolve()
    if not source_directory.is_dir():
        raise SystemExit(f"Source directory does not exist: {source_directory}")
    output_directory.mkdir(parents=True, exist_ok=True)

    gdal_translate = require_tool("gdal_translate")
    gdalwarp = require_tool("gdalwarp")
    gdaladdo = require_tool("gdaladdo")

    discovered_sources = discover_sources(source_directory)
    if args.all_frames:
        selected_sources = sorted(discovered_sources.items())
    else:
        missing_ages = [
            age_ma for age_ma in MVP_AGES_MA if age_ma not in discovered_sources
        ]
        if missing_ages:
            raise SystemExit(f"Missing MVP source ages: {missing_ages}")
        selected_sources = [
            (age_ma, discovered_sources[age_ma]) for age_ma in MVP_AGES_MA
        ]

    existing_manifest_path = output_directory / "manifest.json"
    existing_quality: int | None = None
    if existing_manifest_path.exists():
        try:
            existing_manifest = json.loads(
                existing_manifest_path.read_text(encoding="utf-8"),
            )
            existing_quality = existing_manifest.get("tiles", {}).get(
                "jpegQuality",
            )
        except (json.JSONDecodeError, OSError):
            pass

    frames: list[dict[str, object]] = []
    for age_ma, source in selected_sources:
        source_id = f"paleoatlas_{age_ma:03d}"
        output = output_directory / f"{source_id}.mbtiles"
        should_build = (
            args.force
            or existing_quality != args.quality
            or not output.exists()
            or output.stat().st_mtime < source.stat().st_mtime
        )
        if should_build:
            print(f"[build] {age_ma:>3} Ma  {source.name}")
            build_frame(
                source,
                output,
                gdal_translate=gdal_translate,
                gdalwarp=gdalwarp,
                gdaladdo=gdaladdo,
                jpeg_quality=args.quality,
            )
        else:
            print(f"[reuse] {age_ma:>3} Ma  {output.name}")

        frames.append(
            {
                "timeMa": age_ma,
                "label": source.stem.rsplit("_", 1)[0],
                "sourceId": source_id,
                "sourceFile": source.name,
                "sourceSha256": sha256(source),
                "tileUrl": f"/atlas-tiles/{source_id}/{{z}}/{{x}}/{{y}}",
                "byteLength": output.stat().st_size,
            },
        )

    is_full_atlas = args.all_frames
    manifest = {
        "schemaVersion": 1,
        "id": (
            "paleomap-paleoatlas-v3"
            if is_full_atlas
            else "paleomap-paleoatlas-v3-mvp"
        ),
        "label": (
            f"PALEOMAP PaleoAtlas Rasters v3 · {len(frames)} source frames"
            if is_full_atlas
            else "PALEOMAP PaleoAtlas Rasters v3 · 8-frame MVP"
        ),
        "attribution": "PALEOMAP PaleoAtlas Rasters v3",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "frameSelection": "nearest",
        "outOfRangePolicy": "hide",
        "timelineStepMa": args.timeline_step_ma,
        "sourceFrameCount": len(frames),
        "sourceRegistration": {
            "crs": "EPSG:4326",
            "bounds": [-180, -90, 180, 90],
            "upperLeft": [-180, 90],
            "lowerRight": [180, -90],
        },
        "tiles": {
            "crs": "EPSG:3857",
            "tileMatrixSet": "WebMercatorQuad",
            "tileSize": 256,
            "format": "image/jpeg",
            "jpegQuality": args.quality,
            "resampling": "bilinear",
            "minimumLevel": 0,
            "maximumLevel": 4,
            "bounds": [-180, -85.0511287798066, 180, 85.0511287798066],
        },
        "frames": frames,
    }
    manifest_path = output_directory / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    total_bytes = sum(int(frame["byteLength"]) for frame in frames)
    print(
        f"[done] {len(frames)} frames, {total_bytes / 1024 / 1024:.1f} MiB, "
        f"manifest: {manifest_path}",
    )


if __name__ == "__main__":
    main()
