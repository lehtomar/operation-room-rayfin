# gridgen — synthetic distribution grid for any Finnish municipality

Generator that turns **MML (Maanmittauslaitos) open data** into a
geographically-honest synthetic MV distribution grid, with stable IDs and a
downstream-traversable topology.

It downloads the map sheets it needs on demand, so a fresh clone can generate a
grid for **any** of the ~309 Finnish municipalities with one command — no manual
data hunting, no API key.

```bash
python -m pip install -r tools/gridgen/requirements.txt

python -m tools.gridgen build --municipality Sysmä        # the demo grid
python -m tools.gridgen build --municipality Kuhmoinen    # anywhere else
```

## CLI

`python -m tools.gridgen <command>` (run from the repo root).

| Command | What it does |
|---|---|
| `municipalities [--search TEXT]` | List/search all Finnish municipalities (name, Swedish name, kunta code, land area). |
| `tiles -m <municipality>` | Show the municipality's TM35FIN extent and every map sheet covering it, with download URLs. |
| `download -m <municipality>` | Fetch + cache those map sheets. |
| `config -m <municipality>` | Write a starter `config/municipality.<slug>.json` derived from the real boundary. |
| `build -m <municipality>` | Download (if needed) and generate the full grid. |

`--municipality` accepts a Finnish name, a Swedish name or a kunta code —
`Sysmä`, `Pargas`, `781` all work, and prefixes match when unambiguous.

Useful flags:

| Flag | Effect |
|---|---|
| `--out DIR` | Write outputs somewhere other than `tools/gridgen/output`. |
| `--force` | Overwrite existing outputs (`build`) or config (`config`). |
| `--feeders N` / `--substations N` | Override the generated grid size. |
| `--source mirror\|local` | Download sheets, or use a pre-downloaded `gridgen.mmlDataDir`. |
| `--refresh` | Re-download cached sheets. |
| `--mtk-year` / `--kuntajako-year` | Pick a different data vintage (global flags — put them *before* the subcommand). |
| `--cache-dir DIR` | Where downloads are cached (default `mml-data/cache/`, gitignored). |

> `build` refuses to overwrite an existing output set unless you pass `--force`,
> because regenerating changes the `seg_id`s that `scenarios/*.json` reference.

### Examples

```bash
python -m tools.gridgen municipalities --search kuhm
python -m tools.gridgen tiles -m 781
python -m tools.gridgen config -m Kuhmoinen --feeders 4 --substations 2
python -m tools.gridgen build -m Kuhmoinen --out tools/gridgen/output-kuhmoinen
```

## Data sources

Both are MML open data (CC BY 4.0), fetched from the public
[Funet mirror](https://www.nic.funet.fi/index/geodata/mml/) — no registration.

| Dataset | Use |
|---|---|
| `SuomenKuntajako_<year>_10k` | The **authoritative municipality polygon** — the full boundary, not clipped to a map sheet. |
| Maastotietokanta (shapefile, 1:10 000) | Buildings, roads and electrical stations, one 12x12 km sheet at a time. |

### Map sheet division

MML publishes Maastotietokanta on the ETRS-TM35FIN sheet grid (JHS 197).
`mmlsource.tile_bounds` implements it analytically, so gridgen can compute
exactly which sheets a municipality needs:

- Level 1 sheets are **192 km (E) x 96 km (N)**, named `<row letter><column>`
  (`M4`), origin E = -76 000, N = 6 570 000. Row letters run `K…X` south→north
  (no `I`/`O`); columns `2…6` west→east.
- Each level is quartered. Quadrant digits are **column-major, south-to-north**:
  `1`=SW, `2`=NW, `3`=SE, `4`=NE.
- A final `L`/`R` splits a 24x12 km sheet into two 12x12 km halves (`L`=west,
  `R`=east) — the level the shapefiles are published at.

So `M4411R` → E 416 000–428 000, N 6 810 000–6 822 000. These extents are
asserted against real published sheets in `test_mmlsource.py`.

### Layers used

Maastotietokanta sheets ship as themed shapefiles `<theme>_<SHEET>_<kind>.shp`
(`r`=buildings, `l`=transport, `j`=utility networks; `p`=area, `v`=line,
`s`=point), with features typed by the numeric `LUOKKA` attribute.

| gridgen input | File | `LUOKKA` |
|---|---|---|
| **käyttöpaikat** | `r_<SHEET>_p` / `r_<SHEET>_s` | `42200–42259`, `42270–42299` |
| **roads** | `l_<SHEET>_v` | `12100–12199` (roads only, not railways) |
| **substation seeds** | `j_<SHEET>_v` | `22200` (Sähköasema) |

Two details worth knowing:

- **Outbuildings are excluded.** Class `4226x` (talousrakennus — sheds, saunas,
  garages) outnumbers real dwellings ~2:1 and shares its main building's
  connection, so counting them would inflate käyttöpaikat several-fold
  (Sysmä: 20 294 → **6 080**).
- **Electrical stations are lines, not points.** MML maps class `22200` as a
  short outline, so it lives in the utility *line* file and is reduced to a
  representative point on load.

## Method

1. **Boundary** — the municipality polygon from Kuntajako.
2. **Käyttöpaikat** — every qualifying building inside the boundary (`KP-#####`).
3. **Transformers** — k-means over building coordinates, `k =
   round(buildings / buildingsPerTransformer)`, optionally clamped by
   `transformerCount.min/max` (`TR-###`). Each building joins its cluster's
   transformer.
4. **Substations** — the municipality's main population centres (k-means), each
   snapped to the nearest real MML electrical station. Municipalities MML records
   no station for fall back to the nearest building, so the generator never fails
   for lack of electrical data.
5. **Feeders** — each transformer → nearest substation; a substation's
   transformers are split into feeders by k-means (`F##`), allocated
   proportionally.
6. **Routing** — build a road graph from the road centrelines (largest connected
   component). For each feeder, snap the substation + its transformers to graph
   nodes and take the single-source shortest-path tree from the substation. The
   tree is collapsed into **feeder segments** spanning significant nodes
   (substation, junctions, transformers), oriented away from the source, with
   `parent_seg_id` topology and real road polylines. Unreachable transformers
   fall back to a straight connector.
7. **Topology closure** — the shared `shared/topology` `RadialNetwork` computes,
   for every segment, the set of downstream transformers + käyttöpaikat. This is
   the single source of truth consumed by the simulator (affected counts) and the
   frontend (fault → downstream highlight).

## Configuration

`config/municipality.<id>.json`, `gridgen` block:

| Key | Meaning |
|---|---|
| `source` | `"mirror"` (download sheets — default) or `"local"` (use `mmlDataDir`). |
| `mtkYear` / `kuntajakoYear` | Data vintage. |
| `buildingsPerTransformer` | Grid density (default 20). |
| `transformerCount.min/max` | Optional hard clamp on the transformer count. |
| `feederCount` | Number of MV feeders. |
| `substationCount` | Number of primary substations. |
| `substations[]` | Optional `{id, name}` overrides, largest population centre first. |
| `mmlDataDir` | Only for `source: "local"` — a pre-downloaded sheet directory. |

`python -m tools.gridgen config -m <municipality>` writes a complete starter file
with the real centre point and bbox filled in.

## Outputs (`output/`)

- `substations` / `transformers` / `kayttopaikat` / `feeders` as **GeoJSON**
  (EPSG:4326) + **Parquet** (with `lon`/`lat`, and `geom_wkt` for lines).
- `topology.json`: per-segment downstream closure, `transformer_nodes`, counts,
  and a `generatedFrom` provenance string naming the data vintage and sheet count.
- `routes.json` (from `routegen.py`): road routes crews drive between depots and
  incident sites.

```bash
python tools/gridgen/routegen.py --municipality sysma --scenario mauri-2026
```

## Tests

```bash
python -m pytest shared/topology tools/gridgen -q
```

- `tools/gridgen/test_mmlsource.py` — sheet-grid maths, download URL scheme and
  layer filters. Fully offline.
- `shared/topology/test_network.py` — pure traversal unit tests.
- `tools/gridgen/test_topology_output.py` — rebuilds the network from generated
  output and checks closure consistency, parent⊇child monotonicity, feeder
  disjointness and feeder-trip magnitude. Set `GRIDGEN_OUTPUT=<dir>` to verify a
  grid generated for another municipality.
