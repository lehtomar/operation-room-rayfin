"""Guard the scenario <-> grid contract.

Scenarios reference concrete `seg_id`s, so regenerating the grid silently
invalidates them: a fault can land on a segment that no longer exists, or on a
two-customer spur where a whole-feeder trip was authored. Nothing else fails
loudly — the app just plays a limp storm. These tests bind the committed
scenarios to the committed grid the way the simulator and frontend do.

Skips automatically if the grid has not been generated.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GRID = Path(os.environ.get("GRIDGEN_OUTPUT", Path(__file__).resolve().parent / "output"))
SCENARIO_DIR = REPO_ROOT / "scenarios"

pytestmark = pytest.mark.skipif(
    not (GRID / "topology.json").exists(),
    reason=f"no gridgen output at {GRID}; run `python -m tools.gridgen build -m <name>`",
)

SCENARIOS = sorted(SCENARIO_DIR.glob("*.json"))


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def topology() -> dict:
    return _load(GRID / "topology.json")


def _bound_entries(scenario: dict) -> list[dict]:
    live = scenario.get("liveSeed", {})
    entries = list(scenario.get("faults", []))
    entries += live.get("incidents", [])
    entries += live.get("maintenance", [])
    return [e for e in entries if "seg_id" in e]


def _name(entry: dict) -> str:
    return entry.get("incident_id") or entry.get("job_id") or "?"


@pytest.mark.parametrize("path", SCENARIOS, ids=lambda p: p.stem)
def test_every_scenario_segment_exists_and_has_customers(path, topology):
    scenario = _load(path)
    segments = topology["segments"]
    for entry in _bound_entries(scenario):
        seg_id = entry["seg_id"]
        assert seg_id in segments, f"{_name(entry)} references missing segment {seg_id}"
        assert segments[seg_id]["kayttopaikka_count"] > 0, (
            f"{_name(entry)} sits on {seg_id}, which feeds nobody"
        )


@pytest.mark.parametrize("path", SCENARIOS, ids=lambda p: p.stem)
def test_scenario_feeder_and_substation_ids_match_the_grid(path, topology):
    import pandas as pd

    scenario = _load(path)
    grid = pd.read_parquet(GRID / "feeders.parquet").set_index("seg_id")
    for entry in _bound_entries(scenario):
        row = grid.loc[entry["seg_id"]]
        assert entry["feeder_id"] == row["feeder_id"], f"{_name(entry)} feeder_id is stale"
        assert entry["ss_id"] == row["ss_id"], f"{_name(entry)} ss_id is stale"


@pytest.mark.parametrize("path", SCENARIOS, ids=lambda p: p.stem)
def test_storm_trips_at_least_one_whole_feeder(path, topology):
    """The demo's payload: a fault that de-energizes a materially large area."""
    import pandas as pd

    scenario = _load(path)
    if not scenario.get("faults"):
        pytest.skip("scenario has no storm faults")
    grid = pd.read_parquet(GRID / "feeders.parquet").set_index("seg_id")
    total = topology["counts"]["kayttopaikat"]

    roots = [f for f in scenario["faults"] if pd.isna(grid.loc[f["seg_id"], "parent_seg_id"])]
    assert roots, "no fault trips a feeder root — the storm has no headline outage"
    biggest = max(topology["segments"][f["seg_id"]]["kayttopaikka_count"] for f in roots)
    assert biggest >= 0.10 * total, (
        f"largest feeder trip is only {biggest} of {total} kayttopaikat"
    )


@pytest.mark.parametrize("path", SCENARIOS, ids=lambda p: p.stem)
def test_every_dispatch_destination_has_a_precomputed_route(path):
    """Crews drive real roads; a missing route silently falls back to a guess.

    Depot ids are derived exactly as `routegen.py` and `src/sim/driver.ts` do:
    unique depot coordinates in crew order.
    """
    routes_file = GRID / "routes.json"
    if not routes_file.exists():
        pytest.skip("routes.json not generated")
    scenario = _load(path)
    routes = _load(routes_file)

    depots: dict[str, str] = {}
    for crew in scenario.get("crews", []):
        key = f"{crew['depot']['lat']:.6f},{crew['depot']['lon']:.6f}"
        depots.setdefault(key, f"DEPOT-{len(depots)}")

    live = scenario.get("liveSeed", {}).get("incidents", [])
    destinations = [f["incident_id"] for f in scenario.get("faults", []) + live]
    origins = list(depots.values()) + destinations

    missing = [
        f"{o}->{d}" for o in origins for d in destinations if o != d and f"{o}->{d}" not in routes
    ]
    assert not missing, f"{len(missing)} missing crew routes, e.g. {missing[:5]}"
