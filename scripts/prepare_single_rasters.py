#!/usr/bin/env python3
"""Colorize the SingleRaster fixtures and package them as Martin MBTiles."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


WEB_MERCATOR_LIMIT = 20_037_508.342789244


@dataclass(frozen=True)
class RasterSpec:
    id: str
    source_file: str
    label: str
    kind: str
    units: str
    minimum: float | None = None
    maximum: float | None = None
    colorbar_file: str | None = None
    colorbar_label: str | None = None
    colorbar_mode: str = "continuous"
    resampling: str = "bilinear"
    maximum_level: int = 4


RASTERS = (
    RasterSpec(
        id="paleoelevation_000",
        source_file="Map01_PALEOMAP_6min_Holocene_0Ma.tif",
        label="PALEOMAP 古高程 · 0 Ma",
        kind="paleoelevation",
        units="m",
        minimum=-11_000,
        maximum=10_500,
        colorbar_file="2 FixedValue/elevation_scotese.cpt",
        colorbar_label="Scotese elevation",
    ),
    RasterSpec(
        id="temperature_000",
        source_file="000_tas_scotese02a_v21321.nc",
        label="Scotese 近地表温度 · 0 Ma",
        kind="temperature",
        units="°C",
        minimum=-40,
        maximum=40,
        colorbar_file="1 Normalized/1 Continuous/thermal.cpt",
        colorbar_label="Thermal",
        maximum_level=1,
    ),
    RasterSpec(
        id="temperature_015",
        source_file="015_tas_scotese02a_v21321.tif",
        label="Scotese 近地表温度 · 15 Ma",
        kind="temperature",
        units="°C",
        minimum=-40,
        maximum=40,
        colorbar_file="1 Normalized/1 Continuous/thermal.cpt",
        colorbar_label="Thermal",
        maximum_level=1,
    ),
    RasterSpec(
        id="seafloor_age_merdith_000",
        source_file="Merdith2021_SEAFLOOR_AGE_grid_0.0Ma.nc",
        label="Merdith 2021 海底年龄 · 0 Ma",
        kind="seafloor-age",
        units="Ma",
        minimum=0,
        maximum=443,
        colorbar_file="2 FixedValue/agegrid.cpt",
        colorbar_label="Age grid",
        colorbar_mode="discrete",
    ),
    RasterSpec(
        id="seafloor_age_merdith_100",
        source_file="Merdith2021_SEAFLOOR_AGE_grid_100.0Ma.nc",
        label="Merdith 2021 海底年龄 · 100 Ma",
        kind="seafloor-age",
        units="Ma",
        minimum=0,
        maximum=443,
        colorbar_file="2 FixedValue/agegrid.cpt",
        colorbar_label="Age grid",
        colorbar_mode="discrete",
    ),
    RasterSpec(
        id="seafloor_age_seton_000",
        source_file="Seton_etal_2020_PresentDay_AgeGrid.nc",
        label="Seton 2020 海底年龄 · 0 Ma",
        kind="seafloor-age",
        units="Ma",
        minimum=0,
        maximum=350,
        colorbar_file="2 FixedValue/agegrid.cpt",
        colorbar_label="Age grid",
        colorbar_mode="discrete",
    ),
    RasterSpec(
        id="seafloor_age_gts2012_000",
        source_file="age.2020.1.GTS2012.6m.nc",
        label="GTS2012 海底年龄 · 0 Ma",
        kind="seafloor-age",
        units="Ma",
        minimum=0,
        maximum=350,
        colorbar_file="2 FixedValue/agegrid.cpt",
        colorbar_label="Age grid",
        colorbar_mode="discrete",
    ),
    RasterSpec(
        id="spreading_rate_bands_000",
        source_file="full_rate_bands.2020.1.GTS2012.6m.nc",
        label="海底扩张速率分带 · 0 Ma",
        kind="spreading-rate-band",
        units="class",
        minimum=1,
        maximum=5,
        colorbar_file="1 Normalized/1 Continuous/batlow.cpt",
        colorbar_label="Batlow",
        colorbar_mode="discrete",
        resampling="near",
    ),
    RasterSpec(
        id="paleomap_rgb_000",
        source_file="Map1a PALEOMAP PaleoAtlas_000.jpg",
        label="PALEOMAP 已着色参考图 · 0 Ma",
        kind="rgb-reference",
        units="",
    ),
)


Color = tuple[int, int, int]
Segment = tuple[float, Color, float, Color]


def parse_args() -> argparse.Namespace:
    project_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(
        description="Generate colorized SingleRaster MBTiles and manifest.",
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=project_root / "data" / "SingleRaster",
    )
    parser.add_argument(
        "--colorbars",
        type=Path,
        default=project_root / "data" / "Colorbar",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=project_root / "data" / "generated" / "single-raster",
    )
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


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


def parse_color(tokens: list[str]) -> Color:
    if len(tokens) == 1 and "/" in tokens[0]:
        components = tokens[0].split("/")
    else:
        components = tokens
    if len(components) != 3:
        raise ValueError(f"Unsupported CPT color: {' '.join(tokens)}")
    return tuple(
        max(0, min(255, round(float(component)))) for component in components
    )  # type: ignore[return-value]


def parse_cpt(path: Path) -> list[Segment]:
    segments: list[Segment] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line[0] in {"B", "F", "N"}:
            continue
        tokens = re.split(r"\s+", line)
        try:
            if "/" in tokens[1]:
                segments.append(
                    (
                        float(tokens[0]),
                        parse_color([tokens[1]]),
                        float(tokens[2]),
                        parse_color([tokens[3]]),
                    ),
                )
            else:
                segments.append(
                    (
                        float(tokens[0]),
                        parse_color(tokens[1:4]),
                        float(tokens[4]),
                        parse_color(tokens[5:8]),
                    ),
                )
        except (IndexError, ValueError) as error:
            raise SystemExit(f"Unable to parse CPT line in {path}: {line}") from error
    if not segments:
        raise SystemExit(f"No color segments found in {path}.")
    return segments


def scale_segments(
    segments: list[Segment],
    minimum: float,
    maximum: float,
) -> list[Segment]:
    source_minimum = segments[0][0]
    source_maximum = segments[-1][2]
    if math.isclose(source_minimum, 0) and math.isclose(source_maximum, 1):
        span = maximum - minimum
        return [
            (
                minimum + start * span,
                start_color,
                minimum + end * span,
                end_color,
            )
            for start, start_color, end, end_color in segments
        ]
    return segments


def sample_color(segments: list[Segment], value: float) -> Color:
    if value <= segments[0][0]:
        return segments[0][1]
    for start, start_color, end, end_color in segments:
        if value <= end:
            if end <= start:
                return end_color
            ratio = max(0, min(1, (value - start) / (end - start)))
            return tuple(
                round(first + (second - first) * ratio)
                for first, second in zip(start_color, end_color, strict=True)
            )  # type: ignore[return-value]
    return segments[-1][3]


def color_relief_text(
    segments: list[Segment],
    *,
    minimum: float,
    maximum: float,
    mode: str,
) -> str:
    lines = ["nv 0 0 0 0"]
    if mode == "discrete":
        epsilon = max((maximum - minimum) * 1e-9, 1e-9)
        for start, start_color, end, _ in segments:
            if end < minimum or start > maximum:
                continue
            clipped_start = max(minimum, start)
            clipped_end = min(maximum, end)
            lines.append(f"{clipped_start:.12g} {' '.join(map(str, start_color))} 255")
            if clipped_end > clipped_start:
                lines.append(
                    f"{max(clipped_start, clipped_end - epsilon):.12g} "
                    f"{' '.join(map(str, start_color))} 255",
                )
        final_color = sample_color(segments, maximum)
        lines.append(f"{maximum:.12g} {' '.join(map(str, final_color))} 255")
    else:
        for start, start_color, _, _ in segments:
            if minimum <= start <= maximum:
                lines.append(f"{start:.12g} {' '.join(map(str, start_color))} 255")
        final_color = sample_color(segments, maximum)
        lines.append(f"{maximum:.12g} {' '.join(map(str, final_color))} 255")
    return "\n".join(lines) + "\n"


def legend_stops(
    segments: list[Segment],
    minimum: float,
    maximum: float,
) -> list[dict[str, object]]:
    stops: list[dict[str, object]] = []
    for index in range(13):
        offset = index / 12
        value = minimum + (maximum - minimum) * offset
        red, green, blue = sample_color(segments, value)
        stops.append(
            {
                "offset": offset,
                "value": value,
                "color": f"rgb({red}, {green}, {blue})",
            },
        )
    return stops


def build_mbtiles(
    spec: RasterSpec,
    source: Path,
    output: Path,
    colorbar: Path | None,
    *,
    gdal_translate: str,
    gdaldem: str,
    gdalwarp: str,
    gdaladdo: str,
) -> tuple[list[dict[str, object]], str | None]:
    with tempfile.TemporaryDirectory(
        prefix="single-raster-",
        dir=output.parent,
    ) as temporary_directory:
        temp = Path(temporary_directory)
        registered = temp / "registered.vrt"
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
                str(registered),
            ],
        )

        input_raster = registered
        stops: list[dict[str, object]] = []
        colorbar_sha256: str | None = None
        if colorbar is not None:
            if spec.minimum is None or spec.maximum is None:
                raise SystemExit(f"{spec.id} requires a value range.")
            segments = scale_segments(
                parse_cpt(colorbar),
                spec.minimum,
                spec.maximum,
            )
            relief = temp / "color-relief.txt"
            relief.write_text(
                color_relief_text(
                    segments,
                    minimum=spec.minimum,
                    maximum=spec.maximum,
                    mode=spec.colorbar_mode,
                ),
                encoding="utf-8",
            )
            colorized = temp / "colorized.tif"
            run(
                [
                    gdaldem,
                    "color-relief",
                    "-q",
                    str(registered),
                    str(relief),
                    str(colorized),
                    "-alpha",
                ],
            )
            input_raster = colorized
            stops = legend_stops(segments, spec.minimum, spec.maximum)
            colorbar_sha256 = sha256(colorbar)

        temporary_mbtiles = temp / output.name
        resolution = (
            2 * WEB_MERCATOR_LIMIT / (256 * (2**spec.maximum_level))
        )
        command = [
            gdalwarp,
            "-q",
            "-overwrite",
            "-multi",
            "-wo",
            "NUM_THREADS=ALL_CPUS",
            "-t_srs",
            "EPSG:3857",
            "-te",
            f"-{WEB_MERCATOR_LIMIT:.15f}",
            f"-{WEB_MERCATOR_LIMIT:.15f}",
            f"{WEB_MERCATOR_LIMIT:.15f}",
            f"{WEB_MERCATOR_LIMIT:.15f}",
            "-te_srs",
            "EPSG:3857",
            "-tr",
            f"{resolution:.15f}",
            f"{resolution:.15f}",
            "-r",
            spec.resampling,
            "-of",
            "MBTILES",
            "-co",
            "TILE_FORMAT=PNG",
            "-co",
            "ZLEVEL=9",
        ]
        if colorbar is not None:
            command.extend(["-srcalpha", "-dstalpha"])
        command.extend([str(input_raster), str(temporary_mbtiles)])
        run(command)

        overview_factors = [
            str(2**level) for level in range(1, spec.maximum_level + 1)
        ]
        if overview_factors:
            run(
                [
                    gdaladdo,
                    "-q",
                    "-r",
                    "nearest" if spec.resampling == "near" else "average",
                    str(temporary_mbtiles),
                    *overview_factors,
                ],
            )
        temporary_mbtiles.replace(output)
        return stops, colorbar_sha256


def main() -> None:
    args = parse_args()
    source_directory = args.source.resolve()
    colorbar_directory = args.colorbars.resolve()
    output_directory = args.output.resolve()
    if not source_directory.is_dir():
        raise SystemExit(f"Source directory does not exist: {source_directory}")
    if not colorbar_directory.is_dir():
        raise SystemExit(f"Colorbar directory does not exist: {colorbar_directory}")
    output_directory.mkdir(parents=True, exist_ok=True)

    gdal_translate = require_tool("gdal_translate")
    gdaldem = require_tool("gdaldem")
    gdalwarp = require_tool("gdalwarp")
    gdaladdo = require_tool("gdaladdo")

    entries: list[dict[str, object]] = []
    for spec in RASTERS:
        source = source_directory / spec.source_file
        colorbar = (
            colorbar_directory / spec.colorbar_file
            if spec.colorbar_file is not None
            else None
        )
        if not source.is_file():
            raise SystemExit(f"Raster source is missing: {source}")
        if colorbar is not None and not colorbar.is_file():
            raise SystemExit(f"Colorbar is missing: {colorbar}")

        source_id = f"single_raster_{spec.id}"
        output = output_directory / f"{source_id}.mbtiles"
        dependency_mtime = max(
            source.stat().st_mtime,
            colorbar.stat().st_mtime if colorbar is not None else 0,
        )
        should_build = (
            args.force
            or not output.exists()
            or output.stat().st_mtime < dependency_mtime
        )
        if should_build:
            print(f"[build] {spec.label}")
            stops, colorbar_sha256 = build_mbtiles(
                spec,
                source,
                output,
                colorbar,
                gdal_translate=gdal_translate,
                gdaldem=gdaldem,
                gdalwarp=gdalwarp,
                gdaladdo=gdaladdo,
            )
        else:
            print(f"[reuse] {spec.label}")
            stops = []
            colorbar_sha256 = sha256(colorbar) if colorbar is not None else None
            if colorbar is not None and spec.minimum is not None and spec.maximum is not None:
                stops = legend_stops(
                    scale_segments(
                        parse_cpt(colorbar),
                        spec.minimum,
                        spec.maximum,
                    ),
                    spec.minimum,
                    spec.maximum,
                )

        entry: dict[str, object] = {
            "id": spec.id,
            "label": spec.label,
            "kind": spec.kind,
            "sourceId": source_id,
            "sourceFile": source.name,
            "sourceSha256": sha256(source),
            "tileUrl": f"/atlas-tiles/{source_id}/{{z}}/{{x}}/{{y}}",
            "byteLength": output.stat().st_size,
            "tiles": {
                "format": "image/png",
                "minimumLevel": 0,
                "maximumLevel": spec.maximum_level,
                "hasAlphaChannel": colorbar is not None,
                # Martin returns 204 for fully transparent tiles omitted by GDAL.
                "emptyTilePolicy": "transparent-204",
            },
            "colorbar": None,
        }
        if colorbar is not None:
            entry["colorbar"] = {
                "label": spec.colorbar_label,
                "sourceFile": str(colorbar.relative_to(colorbar_directory)),
                "sourceSha256": colorbar_sha256,
                "mode": spec.colorbar_mode,
                "minimum": spec.minimum,
                "maximum": spec.maximum,
                "units": spec.units,
                "stops": stops,
            }
        entries.append(entry)

    manifest = {
        "schemaVersion": 1,
        "id": "timemachine-single-raster-colorbar-mvp",
        "label": "SingleRaster + GMT CPT visualization",
        "attribution": "TimeMachine raster fixtures",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "defaultRasterId": RASTERS[0].id,
        "sourceRegistration": {
            "crs": "EPSG:4326",
            "bounds": [-180, -90, 180, 90],
            "upperLeft": [-180, 90],
            "lowerRight": [180, -90],
        },
        "tileMatrixSet": {
            "crs": "EPSG:3857",
            "name": "WebMercatorQuad",
            "tileSize": 256,
            "bounds": [-180, -85.0511287798066, 180, 85.0511287798066],
        },
        "rasters": entries,
    }
    manifest_path = output_directory / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    total_bytes = sum(int(entry["byteLength"]) for entry in entries)
    print(
        f"[done] {len(entries)} rasters, {total_bytes / 1024 / 1024:.1f} MiB, "
        f"manifest: {manifest_path}",
    )


if __name__ == "__main__":
    main()
