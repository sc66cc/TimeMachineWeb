#!/usr/bin/env python3
"""Build deterministic TimeMachineWeb point-rendering fixtures from PBDB XLSX data.

The source workbook is read as OpenXML in streaming mode and is never modified.
Plate IDs are assigned at present day with pyGPlates PlatePartitioner. Output
files use the compact WGP1 binary format consumed by the browser worker.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
import time
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator
from xml.etree import ElementTree

import numpy as np

try:
    import pygplates
except ImportError as error:
    raise SystemExit(
        "pyGPlates is required for scientifically correct Plate ID assignment. "
        "Install pygplates 1.0+ in the Python environment used by this script."
    ) from error


FORMAT_MAGIC = b"WGP1"
FORMAT_VERSION = 1
HEADER_BYTES = 64
UNASSIGNED_PLATE_ID = np.uint16(65_535)
MAX_TIME_MA = 1_100
DEFAULT_VALIDITY_POLICY = "permanent"
DEFAULT_UNASSIGNED_POLICY = "anchor"
BENCHMARK_ANCHOR_PLATE_ID = np.uint16(0)

RECORD_DTYPE = np.dtype(
    [
        ("position", "<f4", (3,)),
        ("valid_from_deci_ma", "<u2"),
        ("valid_to_deci_ma", "<u2"),
        ("plate_id", "<u2"),
        ("occurrence_count", "<u2"),
    ],
    align=False,
)

if RECORD_DTYPE.itemsize != 20:
    raise RuntimeError(f"Unexpected WGP1 record size: {RECORD_DTYPE.itemsize}")

TARGET_COLUMNS = {
    "A": "collection_no",
    "F": "longitude",
    "G": "latitude",
    "K": "occurrence_count",
    "N": "valid_from_ma",
    "O": "valid_to_ma",
}

DATASET_SPECS = (
    ("pbdb-10k", "PBDB 10k", 10_000, "stratified_sample"),
    ("pbdb-100k", "PBDB 100k", 100_000, "stratified_sample"),
    ("pbdb-275k", "PBDB 275k", 275_000, "stratified_sample"),
    ("pbdb-real", "PBDB real", None, "full_valid_source"),
    ("pbdb-1m", "PBDB 1M", 1_000_000, "deterministic_repeat"),
    ("pbdb-3m", "PBDB 3M", 3_000_000, "deterministic_repeat"),
    ("pbdb-5m", "PBDB 5M", 5_000_000, "deterministic_repeat"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate WGP1 point fixtures from the supplied PBDB workbook."
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=Path("data/PointData/pbdb_data.xlsx"),
    )
    parser.add_argument(
        "--polygons",
        type=Path,
        default=Path("data/PlateModelData/PALEOMAP_PlatePolygons.gpml"),
    )
    parser.add_argument(
        "--rotations",
        type=Path,
        default=Path("data/PlateModelData/PALEOMAP_PlateModel.rot"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/generated/points"),
    )
    parser.add_argument(
        "--cache",
        type=Path,
        default=Path("data/generated/points/pbdb-assigned-base.npz"),
        help="Reusable cache of cleaned PBDB rows and their assigned Plate IDs.",
    )
    parser.add_argument(
        "--force-assignment",
        action="store_true",
        help="Ignore any compatible assignment cache.",
    )
    parser.add_argument(
        "--validity",
        choices=("permanent", "source"),
        default=DEFAULT_VALIDITY_POLICY,
        help=(
            "Point time validity. 'permanent' keeps every assigned point "
            "resident from 0–1100 Ma for worst-case rendering benchmarks."
        ),
    )
    parser.add_argument(
        "--unassigned",
        choices=("anchor", "hide"),
        default=DEFAULT_UNASSIGNED_POLICY,
        help=(
            "Benchmark handling for source points without a Plate ID. "
            "'anchor' assigns them to fixed Plate 0 so every record renders."
        ),
    )
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def column_name(reference: str) -> str:
    index = 0
    while index < len(reference) and reference[index].isalpha():
        index += 1
    return reference[:index]


def read_numeric_pbdb_rows(source: Path) -> tuple[dict[str, np.ndarray], dict]:
    print(f"[1/4] Streaming numeric PBDB columns from {source}", flush=True)
    values: dict[str, list[float]] = {
        field_name: [] for field_name in TARGET_COLUMNS.values()
    }
    rejected = Counter()
    current_row: dict[str, float] = {}
    source_row_count = 0

    with zipfile.ZipFile(source) as archive:
        with archive.open("xl/worksheets/sheet1.xml") as sheet:
            for _, element in ElementTree.iterparse(sheet, events=("end",)):
                local_name = element.tag.rsplit("}", 1)[-1]
                if local_name == "c":
                    column = column_name(element.attrib.get("r", ""))
                    field_name = TARGET_COLUMNS.get(column)
                    if field_name and element.attrib.get("t") != "s":
                        value_element = element.find(
                            "{http://schemas.openxmlformats.org/"
                            "spreadsheetml/2006/main}v"
                        )
                        if value_element is not None and value_element.text is not None:
                            try:
                                current_row[field_name] = float(value_element.text)
                            except ValueError:
                                pass
                elif local_name == "row":
                    sheet_row = int(element.attrib.get("r", "0"))
                    if sheet_row > 1:
                        source_row_count += 1
                        required = (
                            "collection_no",
                            "longitude",
                            "latitude",
                            "valid_from_ma",
                            "valid_to_ma",
                        )
                        if not all(name in current_row for name in required):
                            rejected["missing_required_value"] += 1
                        else:
                            longitude = current_row["longitude"]
                            latitude = current_row["latitude"]
                            valid_from_ma = current_row["valid_from_ma"]
                            valid_to_ma = current_row["valid_to_ma"]
                            numeric_values = (
                                longitude,
                                latitude,
                                valid_from_ma,
                                valid_to_ma,
                            )
                            if not all(math.isfinite(value) for value in numeric_values):
                                rejected["non_finite_value"] += 1
                            elif not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
                                rejected["coordinate_out_of_range"] += 1
                            elif (
                                valid_to_ma < 0
                                or valid_from_ma < valid_to_ma
                                or valid_from_ma > MAX_TIME_MA
                            ):
                                rejected["invalid_age_interval"] += 1
                            else:
                                for name in TARGET_COLUMNS.values():
                                    default_value = (
                                        0.0 if name == "occurrence_count" else math.nan
                                    )
                                    values[name].append(
                                        current_row.get(name, default_value)
                                    )
                    current_row.clear()
                    element.clear()

    arrays = {
        "collection_no": np.asarray(values["collection_no"], dtype=np.uint32),
        "longitude": np.asarray(values["longitude"], dtype=np.float64),
        "latitude": np.asarray(values["latitude"], dtype=np.float64),
        "occurrence_count": np.clip(
            np.asarray(values["occurrence_count"], dtype=np.float64),
            0,
            np.iinfo(np.uint16).max,
        ).astype(np.uint16),
        "valid_from_ma": np.asarray(values["valid_from_ma"], dtype=np.float64),
        "valid_to_ma": np.asarray(values["valid_to_ma"], dtype=np.float64),
    }
    quality = {
        "sourceRowCount": source_row_count,
        "acceptedRowCount": int(arrays["longitude"].size),
        "rejectedRowCount": int(sum(rejected.values())),
        "rejectedByReason": dict(sorted(rejected.items())),
    }
    print(
        f"      accepted {quality['acceptedRowCount']:,} / "
        f"{quality['sourceRowCount']:,} rows; rejected "
        f"{quality['rejectedRowCount']:,}",
        flush=True,
    )
    return arrays, quality


def assign_plate_ids(
    arrays: dict[str, np.ndarray],
    polygons: Path,
    rotations: Path,
) -> tuple[np.ndarray, dict]:
    point_count = arrays["longitude"].size
    print(
        f"[2/4] Assigning Plate IDs to {point_count:,} points with "
        f"pyGPlates {pygplates.__version__}",
        flush=True,
    )
    started = time.perf_counter()
    partitioner = pygplates.PlatePartitioner(polygons, rotations)
    plate_ids = np.full(point_count, UNASSIGNED_PLATE_ID, dtype=np.uint16)

    for index, (latitude, longitude) in enumerate(
        zip(arrays["latitude"], arrays["longitude"], strict=True)
    ):
        reconstructed_polygon = partitioner.partition_point(
            (float(latitude), float(longitude))
        )
        if reconstructed_polygon is not None:
            plate_id = (
                reconstructed_polygon.get_feature().get_reconstruction_plate_id()
            )
            if not 0 <= plate_id < int(UNASSIGNED_PLATE_ID):
                raise ValueError(f"Plate ID {plate_id} cannot be encoded as uint16")
            plate_ids[index] = plate_id

        if (index + 1) % 25_000 == 0 or index + 1 == point_count:
            elapsed = time.perf_counter() - started
            rate = (index + 1) / elapsed
            print(
                f"      {index + 1:>7,} / {point_count:,} "
                f"({rate:,.0f} points/s)",
                flush=True,
            )

    assigned_mask = plate_ids != UNASSIGNED_PLATE_ID
    assigned_count = int(np.count_nonzero(assigned_mask))
    assignment = {
        "engine": "pyGPlates",
        "engineVersion": pygplates.__version__,
        "reconstructionTimeMa": 0,
        "assignedCount": assigned_count,
        "unassignedCount": int(point_count - assigned_count),
        "uniqueAssignedPlateCount": int(np.unique(plate_ids[assigned_mask]).size),
        "elapsedSeconds": round(time.perf_counter() - started, 3),
    }
    return plate_ids, assignment


def source_hashes(source: Path, polygons: Path, rotations: Path) -> dict[str, str]:
    return {
        "workbookSha256": sha256_file(source),
        "polygonsSha256": sha256_file(polygons),
        "rotationsSha256": sha256_file(rotations),
    }


def load_or_build_base(
    source: Path,
    polygons: Path,
    rotations: Path,
    cache: Path,
    force_assignment: bool,
) -> tuple[dict[str, np.ndarray], dict, dict, dict[str, str]]:
    hashes = source_hashes(source, polygons, rotations)
    if cache.exists() and not force_assignment:
        with np.load(cache, allow_pickle=False) as cached:
            cache_hashes = {
                "workbookSha256": str(cached["workbook_sha256"].item()),
                "polygonsSha256": str(cached["polygons_sha256"].item()),
                "rotationsSha256": str(cached["rotations_sha256"].item()),
            }
            if cache_hashes == hashes:
                print(f"[1/4] Reusing compatible Plate ID cache {cache}", flush=True)
                arrays = {
                    name: cached[name]
                    for name in (
                        "collection_no",
                        "longitude",
                        "latitude",
                        "occurrence_count",
                        "valid_from_ma",
                        "valid_to_ma",
                        "plate_id",
                    )
                }
                quality = json.loads(str(cached["quality_json"].item()))
                assignment = json.loads(str(cached["assignment_json"].item()))
                assignment["cacheReused"] = True
                return arrays, quality, assignment, hashes

    arrays, quality = read_numeric_pbdb_rows(source)
    plate_ids, assignment = assign_plate_ids(arrays, polygons, rotations)
    arrays["plate_id"] = plate_ids
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        cache,
        **arrays,
        workbook_sha256=np.asarray(hashes["workbookSha256"]),
        polygons_sha256=np.asarray(hashes["polygonsSha256"]),
        rotations_sha256=np.asarray(hashes["rotationsSha256"]),
        quality_json=np.asarray(json.dumps(quality, sort_keys=True)),
        assignment_json=np.asarray(json.dumps(assignment, sort_keys=True)),
    )
    print(f"      wrote reusable assignment cache {cache}", flush=True)
    assignment["cacheReused"] = False
    return arrays, quality, assignment, hashes


def to_unit_vectors(longitudes: np.ndarray, latitudes: np.ndarray) -> np.ndarray:
    longitude_radians = np.deg2rad(longitudes)
    latitude_radians = np.deg2rad(latitudes)
    cos_latitude = np.cos(latitude_radians)
    positions = np.empty((longitudes.size, 3), dtype=np.float32)
    positions[:, 0] = cos_latitude * np.cos(longitude_radians)
    positions[:, 1] = cos_latitude * np.sin(longitude_radians)
    positions[:, 2] = np.sin(latitude_radians)
    return positions


def stratified_indices(source_count: int, point_count: int) -> np.ndarray:
    if point_count > source_count:
        raise ValueError("Stratified samples cannot exceed source size")
    return (
        np.arange(point_count, dtype=np.uint64) * np.uint64(source_count)
        // np.uint64(point_count)
    ).astype(np.int64)


def iter_fixture_indices(
    source_count: int,
    point_count: int,
    generation: str,
    chunk_size: int = 500_000,
) -> Iterator[np.ndarray]:
    if generation in {"stratified_sample", "full_valid_source"}:
        if generation == "full_valid_source":
            selected = np.arange(source_count, dtype=np.int64)
        else:
            selected = stratified_indices(source_count, point_count)
        for start in range(0, point_count, chunk_size):
            yield selected[start : start + chunk_size]
        return

    if generation == "deterministic_repeat":
        for start in range(0, point_count, chunk_size):
            stop = min(point_count, start + chunk_size)
            yield np.arange(start, stop, dtype=np.int64) % source_count
        return

    raise ValueError(f"Unsupported fixture generation mode {generation}")


def encode_time_ranges(
    valid_from_ma: np.ndarray,
    valid_to_ma: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    valid_from = np.floor(valid_from_ma * 10 + 1e-7).astype(np.uint16)
    valid_to = np.ceil(valid_to_ma * 10 - 1e-7).astype(np.uint16)
    return valid_from, valid_to


def fixture_time_ranges(
    arrays: dict[str, np.ndarray],
    indices: np.ndarray,
    validity_policy: str,
) -> tuple[np.ndarray, np.ndarray]:
    if validity_policy == "permanent":
        return (
            np.full(indices.size, MAX_TIME_MA * 10, dtype=np.uint16),
            np.zeros(indices.size, dtype=np.uint16),
        )
    return encode_time_ranges(
        arrays["valid_from_ma"][indices],
        arrays["valid_to_ma"][indices],
    )


def fixture_plate_ids(
    arrays: dict[str, np.ndarray],
    indices: np.ndarray,
    unassigned_policy: str,
) -> np.ndarray:
    plate_ids = arrays["plate_id"][indices]
    if unassigned_policy == "anchor":
        return np.where(
            plate_ids == UNASSIGNED_PLATE_ID,
            BENCHMARK_ANCHOR_PLATE_ID,
            plate_ids,
        ).astype(np.uint16, copy=False)
    return plate_ids


def build_header(
    point_count: int,
    source_point_count: int,
    max_plate_id: int,
) -> bytes:
    header = bytearray(HEADER_BYTES)
    struct.pack_into(
        "<4sIIIIIII",
        header,
        0,
        FORMAT_MAGIC,
        FORMAT_VERSION,
        HEADER_BYTES,
        RECORD_DTYPE.itemsize,
        point_count,
        source_point_count,
        max_plate_id,
        MAX_TIME_MA * 10,
    )
    return bytes(header)


def active_counts_by_integer_ma(
    arrays: dict[str, np.ndarray],
    source_count: int,
    point_count: int,
    generation: str,
    validity_policy: str,
    unassigned_policy: str,
) -> list[int]:
    differences = np.zeros(MAX_TIME_MA * 10 + 2, dtype=np.int64)
    for indices in iter_fixture_indices(source_count, point_count, generation):
        valid_from, valid_to = fixture_time_ranges(
            arrays,
            indices,
            validity_policy,
        )
        plate_ids = fixture_plate_ids(arrays, indices, unassigned_policy)
        usable = (
            (valid_from >= valid_to)
            & (plate_ids != UNASSIGNED_PLATE_ID)
        )
        np.add.at(differences, valid_to[usable], 1)
        np.add.at(differences, valid_from[usable].astype(np.int64) + 1, -1)
    counts = np.cumsum(differences[:-1])
    return [int(counts[time_ma * 10]) for time_ma in range(MAX_TIME_MA + 1)]


def write_fixture(
    output_dir: Path,
    dataset_id: str,
    label: str,
    point_count: int,
    generation: str,
    arrays: dict[str, np.ndarray],
    positions: np.ndarray,
    max_plate_id: int,
    validity_policy: str,
    unassigned_policy: str,
) -> dict:
    path = output_dir / f"{dataset_id}.wgp"
    source_count = positions.shape[0]
    header = build_header(point_count, source_count, max_plate_id)
    digest = hashlib.sha256()
    digest.update(header)

    started = time.perf_counter()
    with path.open("wb") as stream:
        stream.write(header)
        written = 0
        for indices in iter_fixture_indices(
            source_count, point_count, generation
        ):
            records = np.empty(indices.size, dtype=RECORD_DTYPE)
            records["position"] = positions[indices]
            valid_from, valid_to = fixture_time_ranges(
                arrays,
                indices,
                validity_policy,
            )
            records["valid_from_deci_ma"] = valid_from
            records["valid_to_deci_ma"] = valid_to
            records["plate_id"] = fixture_plate_ids(
                arrays,
                indices,
                unassigned_policy,
            )
            records["occurrence_count"] = arrays["occurrence_count"][indices]
            payload = memoryview(records).cast("B")
            stream.write(payload)
            digest.update(payload)
            written += indices.size
            print(
                f"\r      {dataset_id}: {written:>9,} / {point_count:,}",
                end="",
                flush=True,
            )
    print(flush=True)

    unique_source_points = (
        point_count if point_count <= source_count else source_count
    )
    active_counts = active_counts_by_integer_ma(
        arrays,
        source_count,
        point_count,
        generation,
        validity_policy,
        unassigned_policy,
    )
    return {
        "id": dataset_id,
        "label": label,
        "url": f"/point-data/{path.name}",
        "fileName": path.name,
        "pointCount": point_count,
        "uniqueSourcePointCount": unique_source_points,
        "generation": generation,
        "byteLength": path.stat().st_size,
        "sha256": digest.hexdigest(),
        "recordStrideBytes": RECORD_DTYPE.itemsize,
        "activeCountsByIntegerMa": active_counts,
        "writeElapsedSeconds": round(time.perf_counter() - started, 3),
    }


def main() -> None:
    args = parse_args()
    for required_path in (args.source, args.polygons, args.rotations):
        if not required_path.is_file():
            raise SystemExit(f"Required input does not exist: {required_path}")

    args.output.mkdir(parents=True, exist_ok=True)
    arrays, quality, assignment, hashes = load_or_build_base(
        args.source,
        args.polygons,
        args.rotations,
        args.cache,
        args.force_assignment,
    )
    source_count = int(arrays["longitude"].size)
    positions = to_unit_vectors(arrays["longitude"], arrays["latitude"])
    assigned_plate_ids = arrays["plate_id"][
        arrays["plate_id"] != UNASSIGNED_PLATE_ID
    ]
    max_plate_id = int(assigned_plate_ids.max(initial=0))
    plate_histogram = Counter(int(value) for value in assigned_plate_ids)

    print("[3/4] Writing deterministic WGP1 fixtures", flush=True)
    datasets = []
    for dataset_id, label, configured_count, generation in DATASET_SPECS:
        point_count = source_count if configured_count is None else configured_count
        datasets.append(
            write_fixture(
                args.output,
                dataset_id,
                label,
                point_count,
                generation,
                arrays,
                positions,
                max_plate_id,
                args.validity,
                args.unassigned,
            )
        )

    manifest = {
        "format": {
            "magic": FORMAT_MAGIC.decode("ascii"),
            "version": FORMAT_VERSION,
            "headerBytes": HEADER_BYTES,
            "recordStrideBytes": RECORD_DTYPE.itemsize,
            "recordLayout": [
                {"name": "unitPosition", "offset": 0, "type": "float32x3"},
                {
                    "name": "validFromDeciMa",
                    "offset": 12,
                    "type": "uint16",
                },
                {
                    "name": "validToDeciMa",
                    "offset": 14,
                    "type": "uint16",
                },
                {"name": "plateId", "offset": 16, "type": "uint16"},
                {
                    "name": "occurrenceCount",
                    "offset": 18,
                    "type": "uint16",
                },
            ],
        },
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "validityPolicy": (
            "permanent_0_1100_ma"
            if args.validity == "permanent"
            else "source_intervals"
        ),
        "unassignedPointPolicy": (
            "anchor_plate_0_for_benchmark"
            if args.unassigned == "anchor"
            else "hidden"
        ),
        "source": {
            "workbook": str(args.source),
            "platePolygons": str(args.polygons),
            "rotationModel": str(args.rotations),
            **hashes,
        },
        "quality": quality,
        "plateAssignment": assignment,
        "basePointCount": source_count,
        "maxPlateId": max_plate_id,
        "plateHistogram": {
            str(plate_id): count
            for plate_id, count in sorted(plate_histogram.items())
        },
        "datasets": datasets,
    }
    manifest_path = args.output / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    print("[4/4] Verifying fixture sizes and hashes", flush=True)
    for dataset in datasets:
        fixture_path = args.output / dataset["fileName"]
        expected_size = (
            HEADER_BYTES + dataset["pointCount"] * RECORD_DTYPE.itemsize
        )
        if fixture_path.stat().st_size != expected_size:
            raise RuntimeError(
                f"{fixture_path} has {fixture_path.stat().st_size} bytes; "
                f"expected {expected_size}"
            )
        if sha256_file(fixture_path) != dataset["sha256"]:
            raise RuntimeError(f"Checksum mismatch for {fixture_path}")

    print(
        f"      wrote {len(datasets)} fixtures and {manifest_path}; "
        f"base points={source_count:,}, max Plate ID={max_plate_id}",
        flush=True,
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        raise SystemExit(130)
