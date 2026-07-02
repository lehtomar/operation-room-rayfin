# gridgen — synthetic Sysmä distribution grid

One-time generator that turns local **MML Maastotietokanta** data into a
geographically-honest synthetic MV distribution grid for Sysmä, with stable IDs
and a downstream-traversable topology.

## Run

```bash
python -m pip install -r tools/gridgen/requirements.txt
python tools/gridgen/gridgen.py            # from the repo root
```

Reads `config/municipality.sysma.json` and `mml-data/M44/*.shp` (EPSG:3067).
Writes to `tools/gridgen/output/` (committed so the app has data without the
raw MML tiles).

## Data sources (all local, offline, real)

| Layer | MML file | Use |
|-------|----------|-----|
| Municipality boundary | `M44_HallintoAlue` (kunta 781) | clip everything to Sysmä |
| Building points | `M44_RakennusPiste` | ~2,879 → **käyttöpaikat** |
| Roads | `M44_TieViiva` | feeder routing + crew movement graph |
| Electrical points | `M44_SahkoPiste` | seed the 2 primary **substations** (real points) |
| Power lines | `M44_SahkoLinja` | (frontend context backbone only) |

Sysmä extends south of the M44 map sheet, so the building count (~2,879) is
slightly below the 3,000–4,500 target — accepted and documented.

## Method

1. **Clip** to the Sysmä polygon.
2. **Käyttöpaikat** = building points inside Sysmä (`KP-#####`).
3. **Transformers** = k-means over building coordinates, `k =
   clamp(round(buildings/20), 120, 180)` ≈ 144 (`TR-###`). Location = cluster
   centroid; each building is assigned to its cluster's transformer.
4. **Substations** = the real `SahkoPiste` points inside Sysmä, north→south →
   `SS-SYSMA` (central) and `SS-NUORAMOINEN` (south).
5. **Feeders** (`feederCount`, default 6): each transformer → nearest
   substation; a substation's transformers are split into feeders by k-means
   (`F##`), allocated proportionally.
6. **Routing**: build a road graph from `TieViiva` (largest connected
   component). For each feeder, snap the substation + its transformers to graph
   nodes and take the single-source shortest-path tree from the substation. The
   tree is collapsed into **feeder segments** spanning significant nodes
   (substation, junctions, transformers), oriented away from the source, with
   `parent_seg_id` topology and real road polylines. Unreachable transformers
   fall back to a straight connector.
7. **Topology closure**: the shared `shared/topology` `RadialNetwork` computes,
   for every segment, the set of downstream transformers + käyttöpaikat. This is
   the single source of truth consumed by the simulator (affected counts) and
   the frontend (fault → downstream highlight).

## Outputs (`output/`)

- `substations` / `transformers` / `kayttopaikat` / `feeders` as **GeoJSON**
  (EPSG:4326) + **Parquet** (with `lon`/`lat`, and `geom_wkt` for lines).
- `topology.json`: per-segment downstream closure + `transformer_nodes`.

## Tests

- `shared/topology/test_network.py` — pure traversal unit tests (hand-built
  network, fault segment → expected sets).
- `tools/gridgen/test_topology_output.py` — rebuilds the network from generated
  output and checks closure consistency, parent⊇child monotonicity, feeder
  disjointness, and the 600+ customer feeder.

```bash
python -m pytest shared/topology tools/gridgen -q
```
