"""gridgen — generate a geographically-honest synthetic distribution grid for
Sysmä from local MML (Maastotietokanta) data.

Pipeline
--------
1. Clip to the Sysmä municipality (HallintoAlue, kunta 781).
2. Buildings (RakennusPiste) inside Sysmä  ->  käyttöpaikat (customer points).
3. Two primary substations seeded from real SahkoPiste electrical points.
4. k-means clusters buildings into ~120-180 distribution-transformer areas.
5. Each transformer -> nearest substation; substation transformers split into
   feeders; feeders routed along the real road network (TieViiva) as
   shortest-path trees, then collapsed into feeder *segments* with parent/child
   topology.
6. The shared `RadialNetwork` computes the downstream closure for every segment.
7. Outputs GeoJSON (EPSG:4326) + Parquet + topology.json with stable IDs.

Run:  python -m tools.gridgen.gridgen        (from the repo root)
"""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path
from typing import Dict, List, Tuple

import geopandas as gpd
import networkx as nx
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Point
from sklearn.cluster import KMeans

# Make `shared.topology` importable when run as a plain script.
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from shared.topology import RadialNetwork, Segment  # noqa: E402

TM35FIN = "EPSG:3067"
WGS84 = "EPSG:4326"

CONFIG_PATH = REPO_ROOT / "config" / f"municipality.{os.environ.get('MUNICIPALITY', 'sysma')}.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"


# --------------------------------------------------------------------------
# Loading & clipping
# --------------------------------------------------------------------------
def load_config() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def load_sysma_boundary(mml_dir: Path):
    ha = gpd.read_file(mml_dir / "M44_HallintoAlue.shp")
    sysma = ha[ha["Kunta_ni1"] == "Sysmä"]
    if sysma.empty:
        # Fall back to municipality code if the name encoding differs.
        sysma = ha[ha["Kunta"] == "781"]
    return sysma.dissolve().geometry.iloc[0]


def load_buildings(mml_dir: Path, boundary) -> gpd.GeoDataFrame:
    rp = gpd.read_file(mml_dir / "M44_RakennusPiste.shp", bbox=boundary.bounds)
    rp = rp[rp.within(boundary)].reset_index(drop=True)
    rp["kp_id"] = [f"KP-{i + 1:05d}" for i in range(len(rp))]
    return rp[["kp_id", "geometry"]]


def load_substations(mml_dir: Path, boundary, cfg: dict) -> gpd.GeoDataFrame:
    sp = gpd.read_file(mml_dir / "M44_SahkoPiste.shp")
    sp = sp[sp.within(boundary)].reset_index(drop=True)
    seeds = cfg["gridgen"]["substations"]
    # Order real electrical points north-to-south and map to configured seeds:
    # the northern/central point is the "Sysmä" substation, the southern one is
    # "Nuoramoinen" (both are genuine SahkoPiste locations).
    sp = sp.sort_values(by="geometry", key=lambda s: s.map(lambda g: -g.y))
    pts = list(sp.geometry)[: len(seeds)]
    if len(pts) < len(seeds):
        raise RuntimeError(
            f"Need {len(seeds)} substation seed points, found {len(pts)} "
            "SahkoPiste in Sysmä."
        )
    rows = []
    for seed, g in zip(seeds, pts):
        rows.append({"ss_id": seed["id"], "name": seed["name"], "geometry": g})
    return gpd.GeoDataFrame(rows, crs=TM35FIN)


# --------------------------------------------------------------------------
# Transformers (clustering)
# --------------------------------------------------------------------------
def cluster_transformers(
    buildings: gpd.GeoDataFrame, cfg: dict
) -> Tuple[gpd.GeoDataFrame, np.ndarray]:
    coords = np.array([[g.x, g.y] for g in buildings.geometry])
    target = round(len(buildings) / 20)
    lo, hi = cfg["gridgen"]["transformerCount"]["min"], cfg["gridgen"][
        "transformerCount"
    ]["max"]
    k = int(min(max(target, lo), hi))
    km = KMeans(n_clusters=k, n_init=4, random_state=42).fit(coords)
    labels = km.labels_
    rows = []
    for ci in range(k):
        cx, cy = km.cluster_centers_[ci]
        rows.append(
            {
                "tr_id": f"TR-{ci + 1:03d}",
                "kp_count": int((labels == ci).sum()),
                "geometry": Point(cx, cy),
            }
        )
    tr = gpd.GeoDataFrame(rows, crs=TM35FIN)
    return tr, labels


# --------------------------------------------------------------------------
# Road graph
# --------------------------------------------------------------------------
def build_road_graph(mml_dir: Path, boundary) -> Tuple[nx.Graph, dict]:
    tv = gpd.read_file(mml_dir / "M44_TieViiva.shp", bbox=boundary.bounds)
    g = nx.Graph()
    edge_coords: Dict[Tuple[str, str], List[Tuple[float, float]]] = {}

    def node_id(x: float, y: float) -> str:
        return f"{round(x)}_{round(y)}"

    for geom in tv.geometry:
        lines = geom.geoms if geom.geom_type == "MultiLineString" else [geom]
        for line in lines:
            cs = list(line.coords)
            for a, b in zip(cs[:-1], cs[1:]):
                ua, ub = node_id(*a), node_id(*b)
                if ua == ub:
                    continue
                d = math.dist(a, b)
                if g.has_edge(ua, ub):
                    if d < g[ua][ub]["weight"]:
                        g[ua][ub]["weight"] = d
                        edge_coords[(ua, ub)] = [a, b]
                else:
                    g.add_edge(ua, ub, weight=d)
                    edge_coords[(ua, ub)] = [a, b]
                g.nodes[ua]["xy"] = a
                g.nodes[ub]["xy"] = b

    # Keep only the largest connected component for reliable routing.
    largest = max(nx.connected_components(g), key=len)
    g = g.subgraph(largest).copy()
    return g, edge_coords


def make_snapper(graph: nx.Graph):
    nodes = list(graph.nodes)
    xy = np.array([graph.nodes[n]["xy"] for n in nodes])
    tree = cKDTree(xy)

    def snap(point: Point) -> str:
        _, idx = tree.query([point.x, point.y])
        return nodes[int(idx)]

    return snap


# --------------------------------------------------------------------------
# Feeder assignment & routing
# --------------------------------------------------------------------------
def assign_feeders(
    tr: gpd.GeoDataFrame, ss: gpd.GeoDataFrame, cfg: dict
) -> gpd.GeoDataFrame:
    ss_coords = np.array([[g.x, g.y] for g in ss.geometry])
    tr_coords = np.array([[g.x, g.y] for g in tr.geometry])
    # nearest substation per transformer
    d = np.linalg.norm(tr_coords[:, None, :] - ss_coords[None, :, :], axis=2)
    tr["ss_id"] = [ss.iloc[i]["ss_id"] for i in d.argmin(axis=1)]

    total_feeders = int(cfg["gridgen"]["feederCount"])
    feeder_ids: List[str] = [""] * len(tr)
    # allocate feeders per substation proportional to transformer count
    counts = tr["ss_id"].value_counts()
    alloc = {}
    remaining = total_feeders
    ss_order = list(ss["ss_id"])
    for i, sid in enumerate(ss_order):
        if i == len(ss_order) - 1:
            alloc[sid] = max(1, remaining)
        else:
            share = max(1, round(total_feeders * counts.get(sid, 0) / len(tr)))
            share = min(share, remaining - (len(ss_order) - 1 - i))
            alloc[sid] = max(1, share)
            remaining -= alloc[sid]

    fseq = 0
    for sid in ss_order:
        mask = (tr["ss_id"] == sid).values
        idx = np.where(mask)[0]
        nf = alloc[sid]
        sub_coords = tr_coords[idx]
        if nf == 1 or len(idx) <= nf:
            labels = np.zeros(len(idx), dtype=int)
        else:
            labels = KMeans(n_clusters=nf, n_init=4, random_state=7).fit_predict(
                sub_coords
            )
        local_to_fid = {}
        for lbl in sorted(set(labels)):
            fseq += 1
            local_to_fid[lbl] = f"F{fseq:02d}"
        for j, lbl in zip(idx, labels):
            feeder_ids[j] = local_to_fid[lbl]
    tr["feeder_id"] = feeder_ids
    return tr


def route_feeder(
    graph: nx.Graph,
    edge_coords: dict,
    snap,
    substation: Point,
    transformers: gpd.GeoDataFrame,
    feeder_id: str,
) -> Tuple[List[dict], Dict[str, str]]:
    """Route one feeder along roads; return segment records + transformer nodes.

    Segments are collapsed spans between *significant* nodes (substation,
    junctions, transformers), oriented away from the substation.
    """
    root = snap(substation)
    tr_node: Dict[str, str] = {}
    for _, row in transformers.iterrows():
        tr_node[row["tr_id"]] = snap(row["geometry"])

    # Single-source shortest-path predecessor tree from the substation.
    try:
        _, paths = nx.single_source_dijkstra(graph, root, weight="weight")
    except nx.NetworkXError:
        paths = {root: [root]}

    parent: Dict[str, str] = {root: None}
    used_nodes = set([root])
    straight: Dict[str, str] = {}  # transformer node -> reason (fallback)
    for tid, node in tr_node.items():
        path = paths.get(node)
        if not path:
            straight[tid] = node  # unreachable on road graph -> straight line
            continue
        for a, b in zip(path[:-1], path[1:]):
            if b not in parent:
                parent[b] = a
            used_nodes.add(a)
            used_nodes.add(b)

    # children map over the used tree
    children: Dict[str, List[str]] = {n: [] for n in used_nodes}
    for n, p in parent.items():
        if p is not None:
            children[p].append(n)

    tr_nodes_set = set(tr_node.values())
    significant = {root}
    significant |= tr_nodes_set
    significant |= {n for n in used_nodes if len(children.get(n, [])) > 1}

    def edge_geom(u: str, v: str) -> List[Tuple[float, float]]:
        if (u, v) in edge_coords:
            return edge_coords[(u, v)]
        if (v, u) in edge_coords:
            return list(reversed(edge_coords[(v, u)]))
        return [graph.nodes[u]["xy"], graph.nodes[v]["xy"]]

    # Walk from each significant child up to its nearest significant ancestor.
    segments: List[dict] = []
    node_to_seg: Dict[str, str] = {}  # to_node -> segment id
    sidx = 0
    for c in significant:
        if c == root:
            continue
        chain = [c]
        p = parent.get(c)
        while p is not None and p not in significant:
            chain.append(p)
            p = parent.get(p)
        if p is None:
            continue
        top = p  # significant ancestor
        chain.append(top)
        chain = list(reversed(chain))  # top ... c  (upstream -> downstream)
        coords: List[Tuple[float, float]] = []
        for a, b in zip(chain[:-1], chain[1:]):
            seg = edge_geom(a, b)
            if coords and seg and coords[-1] == seg[0]:
                coords.extend(seg[1:])
            else:
                coords.extend(seg)
        sidx += 1
        seg_id = f"{feeder_id}-S{sidx:02d}"
        segments.append(
            {
                "seg_id": seg_id,
                "feeder_id": feeder_id,
                "from_node": top,
                "to_node": c,
                "coords": coords,
            }
        )
        node_to_seg[c] = seg_id

    # Fallback straight segments for unreachable transformers.
    for tid, node in straight.items():
        sidx += 1
        seg_id = f"{feeder_id}-S{sidx:02d}"
        coords = [graph.nodes[root]["xy"], (transformers_geom(transformers, tid))]
        segments.append(
            {
                "seg_id": seg_id,
                "feeder_id": feeder_id,
                "from_node": root,
                "to_node": node,
                "coords": [graph.nodes[root]["xy"], graph.nodes[node]["xy"]]
                if node in graph.nodes
                else coords,
            }
        )
        node_to_seg[node] = seg_id

    # parent_segment_id: segment whose to_node == this segment's from_node
    for s in segments:
        s["parent_seg_id"] = node_to_seg.get(s["from_node"])
        s["ss_root"] = root
    return segments, tr_node


def transformers_geom(transformers: gpd.GeoDataFrame, tid: str):
    g = transformers[transformers["tr_id"] == tid].geometry.iloc[0]
    return (g.x, g.y)


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------
def write_outputs(
    ss: gpd.GeoDataFrame,
    tr: gpd.GeoDataFrame,
    kp: gpd.GeoDataFrame,
    seg_gdf: gpd.GeoDataFrame,
    closure: dict,
    tr_node_global: Dict[str, str],
) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    def dump(gdf: gpd.GeoDataFrame, name: str):
        # gdf is in TM35FIN (projected); compute label points there, then
        # reproject for the GeoJSON output and lon/lat columns.
        g4326 = gdf.to_crs(WGS84)
        g4326.to_file(OUTPUT_DIR / f"{name}.geojson", driver="GeoJSON")
        out = pd.DataFrame(g4326.drop(columns="geometry"))
        if gdf.geom_type.iloc[0] == "Point":
            out["lon"] = g4326.geometry.x
            out["lat"] = g4326.geometry.y
        else:
            cent = gpd.GeoSeries(gdf.geometry.centroid, crs=TM35FIN).to_crs(
                WGS84
            )
            out["lon"] = cent.x.values
            out["lat"] = cent.y.values
            out["geom_wkt"] = g4326.geometry.to_wkt().values
        out.to_parquet(OUTPUT_DIR / f"{name}.parquet", index=False)

    dump(ss, "substations")
    dump(tr, "transformers")
    dump(kp, "kayttopaikat")
    dump(seg_gdf, "feeders")

    topo = {
        "generatedFrom": "MML Maastotietokanta (M44), EPSG:3067",
        "counts": {
            "substations": len(ss),
            "transformers": len(tr),
            "kayttopaikat": len(kp),
            "feeder_segments": len(seg_gdf),
        },
        "transformer_nodes": tr_node_global,
        "segments": {
            sid: {
                "transformer_ids": c.transformer_ids,
                "kayttopaikka_count": c.kayttopaikka_count,
                "kayttopaikka_ids": c.kayttopaikka_ids,
            }
            for sid, c in closure.items()
        },
    }
    (OUTPUT_DIR / "topology.json").write_text(
        json.dumps(topo, ensure_ascii=False), encoding="utf-8"
    )


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main() -> None:
    cfg = load_config()
    mml_dir = REPO_ROOT / cfg["gridgen"]["mmlDataDir"]
    print(f"[gridgen] MML dir: {mml_dir}")

    boundary = load_sysma_boundary(mml_dir)
    print(f"[gridgen] Sysmä boundary loaded ({boundary.area / 1e6:.0f} km²)")

    buildings = load_buildings(mml_dir, boundary)
    print(f"[gridgen] käyttöpaikat (buildings): {len(buildings)}")

    ss = load_substations(mml_dir, boundary, cfg)
    print(f"[gridgen] substations: {list(ss['ss_id'])}")

    tr, labels = cluster_transformers(buildings, cfg)
    print(f"[gridgen] transformers: {len(tr)}")

    # building -> transformer
    buildings = buildings.reset_index(drop=True)
    buildings["tr_id"] = [tr.iloc[int(l)]["tr_id"] for l in labels]

    tr = assign_feeders(tr, ss, cfg)
    print(
        f"[gridgen] feeders: {sorted(tr['feeder_id'].unique())} "
        f"({tr['feeder_id'].nunique()} total)"
    )

    graph, edge_coords = build_road_graph(mml_dir, boundary)
    print(
        f"[gridgen] road graph: {graph.number_of_nodes()} nodes, "
        f"{graph.number_of_edges()} edges"
    )
    snap = make_snapper(graph)

    ss_by_id = {row["ss_id"]: row["geometry"] for _, row in ss.iterrows()}
    all_segments: List[dict] = []
    tr_node_global: Dict[str, str] = {}
    for fid in sorted(tr["feeder_id"].unique()):
        f_tr = tr[tr["feeder_id"] == fid]
        sid = f_tr.iloc[0]["ss_id"]
        segs, tr_node = route_feeder(
            graph, edge_coords, snap, ss_by_id[sid], f_tr, fid
        )
        # Namespace node ids per feeder so the global network is a forest of
        # disjoint radial trees (feeders may share raw road nodes).
        for s in segs:
            s["from_node"] = f"{fid}:{s['from_node']}"
            s["to_node"] = f"{fid}:{s['to_node']}"
        for tid, node in tr_node.items():
            tr_node_global[tid] = f"{fid}:{node}"
        all_segments.extend(segs)

    # Build the radial network + closure.
    kp_by_tr: Dict[str, List[str]] = {}
    for _, row in buildings.iterrows():
        kp_by_tr.setdefault(row["tr_id"], []).append(row["kp_id"])

    segment_objs = [
        Segment(s["seg_id"], s["from_node"], s["to_node"], s["feeder_id"])
        for s in all_segments
    ]
    net = RadialNetwork(segment_objs, tr_node_global, kp_by_tr)
    closure = net.closure()

    # attach closure counts + geometry to segment gdf
    seg_rows = []
    for s in all_segments:
        c = closure[s["seg_id"]]
        seg_rows.append(
            {
                "seg_id": s["seg_id"],
                "feeder_id": s["feeder_id"],
                "ss_id": tr[tr["feeder_id"] == s["feeder_id"]].iloc[0]["ss_id"],
                "parent_seg_id": s["parent_seg_id"],
                "from_node": s["from_node"],
                "to_node": s["to_node"],
                "downstream_tr": c.transformer_count,
                "downstream_kp": c.kayttopaikka_count,
                "geometry": LineString(s["coords"])
                if len(s["coords"]) >= 2
                else LineString([s["coords"][0], s["coords"][0]]),
            }
        )
    seg_gdf = gpd.GeoDataFrame(seg_rows, crs=TM35FIN)

    write_outputs(ss, tr, buildings, seg_gdf, closure, tr_node_global)

    # Summary
    root_segs = seg_gdf[seg_gdf["parent_seg_id"].isna()]
    biggest = seg_gdf.loc[seg_gdf["downstream_kp"].idxmax()]
    per_feeder = (
        tr.assign(kp=tr["tr_id"].map(lambda t: len(kp_by_tr.get(t, []))))
        .groupby("feeder_id")["kp"]
        .sum()
        .sort_values(ascending=False)
    )
    print("\n[gridgen] === SUMMARY ===")
    print(f"  substations     : {len(ss)}")
    print(f"  feeders         : {tr['feeder_id'].nunique()}")
    print(f"  transformers    : {len(tr)}")
    print(f"  käyttöpaikat    : {len(buildings)}")
    print(f"  feeder segments : {len(seg_gdf)}")
    print(f"  feeder-root segs: {len(root_segs)}")
    print(f"  käyttöpaikat per feeder: {per_feeder.to_dict()}")
    print(
        f"  biggest segment : {biggest['seg_id']} feeds "
        f"{int(biggest['downstream_kp'])} käyttöpaikkaa"
    )
    print(f"  outputs written to: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
