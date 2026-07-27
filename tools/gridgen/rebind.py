"""rebind — re-point a storm scenario at a freshly generated grid.

Scenarios reference concrete `seg_id`s (`F04-S09`), so regenerating the grid —
new municipality, new MML vintage, different feeder count — invalidates every
fault, maintenance job and live incident in `scenarios/*.json`. Hand-picking
replacements out of `feeders.parquet` is slow and loses the authored intent.

This rebinds each entry automatically, preserving the two things that make a
scenario a scenario:

* **Where it happens** — the new segment is the one nearest the authored
  location, so the storm still sweeps the same geography.
* **How much it hurts** — segments are matched on their share of the
  municipality's käyttöpaikat, so a "whole feeder trips" fault stays a whole
  feeder trip instead of becoming a two-customer spur. Feeder-root faults are
  constrained to feeder roots.

Passing `--from-grid` (the grid the scenario was authored against) enables the
impact matching; without it, entries are rebound on geography alone.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import pandas as pd
from pyproj import Transformer
from shapely import wkt

TO_TM = Transformer.from_crs("EPSG:4326", "EPSG:3067", always_xy=True)
TO_WGS = Transformer.from_crs("EPSG:3067", "EPSG:4326", always_xy=True)

#: Distance at which a candidate is considered "far"; used to normalise scoring.
DISTANCE_SCALE_M = 20_000.0
#: How much impact similarity counts relative to distance.
IMPACT_WEIGHT = 1.5


@dataclass
class Grid:
    segments: pd.DataFrame
    total_kayttopaikat: int

    @classmethod
    def load(cls, directory: Path) -> "Grid":
        directory = Path(directory)
        segments = pd.read_parquet(directory / "feeders.parquet")
        topology = json.loads((directory / "topology.json").read_text(encoding="utf-8"))
        xy = [TO_TM.transform(lon, lat) for lon, lat in zip(segments["lon"], segments["lat"])]
        segments = segments.assign(
            _x=[p[0] for p in xy],
            _y=[p[1] for p in xy],
            _is_root=segments["parent_seg_id"].isna(),
        )
        return cls(segments, int(topology["counts"]["kayttopaikat"]))

    def share(self, seg_id: str) -> float | None:
        row = self.segments[self.segments["seg_id"] == seg_id]
        if row.empty or not self.total_kayttopaikat:
            return None
        return float(row.iloc[0]["downstream_kp"]) / self.total_kayttopaikat

    def is_root(self, seg_id: str) -> bool:
        row = self.segments[self.segments["seg_id"] == seg_id]
        return bool(row.iloc[0]["_is_root"]) if not row.empty else False

    def point_on(self, seg_id: str) -> tuple[float, float]:
        """A point guaranteed to sit on the segment, so map markers hug the line."""
        row = self.segments[self.segments["seg_id"] == seg_id].iloc[0]
        geom = wkt.loads(row["geom_wkt"])
        point = geom.interpolate(0.5, normalized=True)
        return float(point.y), float(point.x)


#: (container, key) pairs in a scenario document that hold grid-bound entries.
BINDABLE = (
    ("faults", None),
    ("liveSeed", "maintenance"),
    ("liveSeed", "incidents"),
)


def _entries(scenario: dict) -> Iterable[dict[str, Any]]:
    for container, key in BINDABLE:
        block = scenario.get(container)
        if block is None:
            continue
        items = block if key is None else block.get(key, [])
        for item in items:
            if "seg_id" in item:
                yield item


def rebind_scenario(
    scenario: dict,
    new_grid: Grid,
    old_grid: Grid | None = None,
    *,
    verbose: bool = True,
) -> list[dict[str, Any]]:
    """Rewrite every grid-bound entry in place. Returns a per-entry report."""
    taken: set[str] = set()
    report: list[dict[str, Any]] = []

    for entry in _entries(scenario):
        old_seg = entry["seg_id"]
        x, y = TO_TM.transform(entry["lon"], entry["lat"])

        want_root = old_grid.is_root(old_seg) if old_grid else False
        want_share = old_grid.share(old_seg) if old_grid else None

        candidates = new_grid.segments
        if want_root:
            candidates = candidates[candidates["_is_root"]]
        free = candidates[~candidates["seg_id"].isin(taken)]
        if not free.empty:
            candidates = free

        distance = ((candidates["_x"] - x) ** 2 + (candidates["_y"] - y) ** 2) ** 0.5
        score = distance / DISTANCE_SCALE_M
        if want_share is not None:
            share = candidates["downstream_kp"] / new_grid.total_kayttopaikat
            score = score + IMPACT_WEIGHT * (share - want_share).abs()

        best = candidates.loc[score.idxmin()]
        seg_id = str(best["seg_id"])
        taken.add(seg_id)

        lat, lon = new_grid.point_on(seg_id)
        entry["seg_id"] = seg_id
        entry["feeder_id"] = str(best["feeder_id"])
        entry["ss_id"] = str(best["ss_id"])
        entry["lat"] = round(lat, 6)
        entry["lon"] = round(lon, 6)

        row = {
            "id": entry.get("incident_id") or entry.get("job_id") or "?",
            "old_seg": old_seg,
            "new_seg": seg_id,
            "feeder": entry["feeder_id"],
            "downstream_kp": int(best["downstream_kp"]),
            "root": bool(best["_is_root"]),
            "moved_km": round(float(distance.loc[best.name]) / 1000, 2),
        }
        report.append(row)
        if verbose:
            print(
                f"  {row['id']:<8} {old_seg:<10} -> {seg_id:<10} {row['feeder']} "
                f"{row['downstream_kp']:>5} kp{' (root)' if row['root'] else '':<7} "
                f"moved {row['moved_km']:>5.2f} km"
            )
    return report


def snap_depots(scenario: dict, grid_dir: Path, *, verbose: bool = True) -> None:
    """Move each crew depot onto its nearest substation in the new grid."""
    substations = pd.read_parquet(Path(grid_dir) / "substations.parquet")
    xy = [TO_TM.transform(lon, lat) for lon, lat in zip(substations["lon"], substations["lat"])]
    for crew in scenario.get("crews", []):
        depot = crew.get("depot")
        if not depot:
            continue
        x, y = TO_TM.transform(depot["lon"], depot["lat"])
        idx = min(range(len(xy)), key=lambda i: (xy[i][0] - x) ** 2 + (xy[i][1] - y) ** 2)
        row = substations.iloc[idx]
        crew["depot"] = {"lat": round(float(row["lat"]), 6), "lon": round(float(row["lon"]), 6)}
        if verbose:
            print(f"  {crew['crew_id']:<5} depot -> {row['name']} ({row['ss_id']})")
