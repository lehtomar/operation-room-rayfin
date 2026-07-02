"""routegen — precompute road routes crews drive along.

Crews travel between their depot and fault sites (and between fault sites) along
the real road network, not straight lines. This reuses gridgen's TieViiva road
graph to compute shortest-path polylines between every relevant origin/dest for
a scenario, and writes them to tools/gridgen/output/routes.json for the frontend
SimDriver to follow.

Run:  MUNICIPALITY=sysma python tools/gridgen/routegen.py [--scenario mauri-2026]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import networkx as nx
from pyproj import Transformer
from shapely.geometry import Point

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import gridgen  # noqa: E402  (reuse road-graph helpers)

OUTPUT = HERE / "output" / "routes.json"
TO_TM = Transformer.from_crs("EPSG:4326", "EPSG:3067", always_xy=True)
TO_WGS = Transformer.from_crs("EPSG:3067", "EPSG:4326", always_xy=True)


def path_coords(path, edge_coords, graph):
    coords = []
    for a, b in zip(path[:-1], path[1:]):
        seg = edge_coords.get((a, b))
        if seg is None:
            rev = edge_coords.get((b, a))
            seg = list(reversed(rev)) if rev else [graph.nodes[a]["xy"], graph.nodes[b]["xy"]]
        if coords and seg and coords[-1] == seg[0]:
            coords.extend(seg[1:])
        else:
            coords.extend(seg)
    return coords


def length_km(coords_tm):
    total = 0.0
    for (x1, y1), (x2, y2) in zip(coords_tm[:-1], coords_tm[1:]):
        total += ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
    return total / 1000.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="mauri-2026")
    args = ap.parse_args()

    cfg = gridgen.load_config()
    mml_dir = REPO_ROOT / cfg["gridgen"]["mmlDataDir"]
    boundary = gridgen.load_sysma_boundary(mml_dir)
    graph, edge_coords = gridgen.build_road_graph(mml_dir, boundary)
    snap = gridgen.make_snapper(graph)
    print(f"[routegen] road graph: {graph.number_of_nodes()} nodes")

    scenario = json.loads(
        (REPO_ROOT / "scenarios" / f"{args.scenario}.json").read_text(encoding="utf-8")
    )

    # points: depot ids (unique by coord, in crew order) + fault sites
    points: dict[str, tuple[float, float]] = {}  # id -> (lat, lon)
    depot_ids: dict[tuple, str] = {}
    for c in scenario["crews"]:
        key = (round(c["depot"]["lat"], 6), round(c["depot"]["lon"], 6))
        if key not in depot_ids:
            did = f"DEPOT-{len(depot_ids)}"
            depot_ids[key] = did
            points[did] = (c["depot"]["lat"], c["depot"]["lon"])
    fault_ids = []
    for f in scenario["faults"]:
        points[f["incident_id"]] = (f["lat"], f["lon"])
        fault_ids.append(f["incident_id"])

    node_of = {}
    for pid, (lat, lon) in points.items():
        x, y = TO_TM.transform(lon, lat)
        node_of[pid] = snap(Point(x, y))

    routes: dict[str, dict] = {}
    for oid in points:  # depots + faults may be origins
        o_node = node_of[oid]
        try:
            _, paths = nx.single_source_dijkstra(graph, o_node, weight="weight")
        except nx.NetworkXError:
            continue
        o_lat, o_lon = points[oid]
        for did in fault_ids:
            if oid == did:
                continue
            path = paths.get(node_of[did])
            if not path:
                continue
            coords_tm = path_coords(path, edge_coords, graph)
            km = length_km(coords_tm)
            d_lat, d_lon = points[did]
            wgs = [list(TO_WGS.transform(x, y)) for (x, y) in coords_tm]  # (lon,lat)
            # anchor exactly at the real origin/dest so crews start/stop on the marker
            line = [[round(o_lon, 6), round(o_lat, 6)]]
            line += [[round(lo, 6), round(la, 6)] for (lo, la) in wgs]
            line.append([round(d_lon, 6), round(d_lat, 6)])
            routes[f"{oid}->{did}"] = {"coords": line, "km": round(km, 3)}

    OUTPUT.write_text(json.dumps(routes, ensure_ascii=False), encoding="utf-8")
    print(f"[routegen] wrote {len(routes)} routes -> {OUTPUT}")


if __name__ == "__main__":
    main()
