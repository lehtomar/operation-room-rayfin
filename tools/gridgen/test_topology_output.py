"""End-to-end topology verification on the *generated* grid.

Complements the pure-unit tests in ``shared/topology/test_network.py`` by
rebuilding the RadialNetwork from gridgen's real output and asserting the
downstream closure is internally consistent (fault segment -> expected
transformer/käyttöpaikka sets). Skips automatically if gridgen hasn't been run.

Point ``GRIDGEN_OUTPUT`` at another directory to verify a grid generated for a
different municipality (``python -m tools.gridgen build -m <name> --out <dir>``).
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from pathlib import Path

import pytest

from shared.topology import RadialNetwork, Segment

OUTPUT = Path(
    os.environ.get("GRIDGEN_OUTPUT", Path(__file__).resolve().parent / "output")
)

pytestmark = pytest.mark.skipif(
    not (OUTPUT / "topology.json").exists(),
    reason=f"no gridgen output at {OUTPUT}; run `python -m tools.gridgen build -m <name>`",
)


def _load():
    import pandas as pd

    feeders = pd.read_parquet(OUTPUT / "feeders.parquet")
    kp = pd.read_parquet(OUTPUT / "kayttopaikat.parquet")
    topo = json.loads((OUTPUT / "topology.json").read_text(encoding="utf-8"))

    segments = [
        Segment(r.seg_id, r.from_node, r.to_node, r.feeder_id)
        for r in feeders.itertuples()
    ]
    kp_by_tr = defaultdict(list)
    for r in kp.itertuples():
        kp_by_tr[r.tr_id].append(r.kp_id)
    net = RadialNetwork(segments, topo["transformer_nodes"], dict(kp_by_tr))
    return feeders, topo, net


def test_generated_network_is_radial_and_closure_matches_stored():
    feeders, topo, net = _load()
    closure = net.closure()
    for seg_id, stored in topo["segments"].items():
        assert (
            closure[seg_id].kayttopaikka_count == stored["kayttopaikka_count"]
        ), f"{seg_id} closure mismatch"
        assert set(closure[seg_id].transformer_ids) == set(
            stored["transformer_ids"]
        )


def test_downstream_is_monotonic_parent_superset_of_child():
    feeders, topo, net = _load()
    seg_by_id = {r.seg_id: r for r in feeders.itertuples()}
    for r in feeders.itertuples():
        if not r.parent_seg_id or r.parent_seg_id not in seg_by_id:
            continue
        child = net.downstream_kayttopaikat(r.seg_id)
        parent = net.downstream_kayttopaikat(r.parent_seg_id)
        assert child.issubset(parent), (
            f"{r.seg_id} not a subset of parent {r.parent_seg_id}"
        )


def test_feeder_root_fault_de_energizes_whole_feeder():
    """Concrete fault -> customer-set check: a fault on a feeder-root segment
    must de-energize exactly that feeder's käyttöpaikat."""
    feeders, topo, net = _load()
    kp_total_by_feeder: dict[str, int] = defaultdict(int)
    # feeder total = union of downstream käyttöpaikat across its root segments
    roots = feeders[feeders["parent_seg_id"].isna()]
    for r in roots.itertuples():
        affected = net.affected_by(
            [s.seg_id for s in roots.itertuples() if s.feeder_id == r.feeder_id]
        )
        kp_total_by_feeder[r.feeder_id] = affected.customers_out

    total_kp = topo["counts"]["kayttopaikat"]
    biggest = max(kp_total_by_feeder.values())
    # A feeder trip must be a materially large event, whatever the municipality.
    assert biggest >= 0.10 * total_kp
    if total_kp >= 3000:
        # Demo-sized grid: at least one feeder is a 600+ customer trip.
        assert biggest >= 600

    # Feeders are electrically disjoint: root downstream sets must not overlap.
    seen: set[str] = set()
    for r in roots.itertuples():
        kps = net.downstream_kayttopaikat(r.seg_id)
        assert not (kps & seen), f"feeder overlap at {r.seg_id}"
        seen |= kps
