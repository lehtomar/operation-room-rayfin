# Grid data sources — expanding gridgen beyond Finland

`tools/gridgen` builds its synthetic distribution grid from **Maastotietokanta**,
Finland's national topographic database (see [`README.md`](./README.md)). This
document surveys the equivalent national topographic and electricity-network
data sources elsewhere, so the same pattern can be pointed at another country.

**Scope:** EU / EEA, United Kingdom, United States, Canada
**Compiled:** 2026-07-27
**Machine-readable companion:** [`sources.yaml`](./sources.yaml)

> **Status: research notes, not a specification.** Items marked ⚠️ were not
> verified against a live service and must be confirmed before use. Licence
> summaries are a reading of the published terms, not legal advice — read the
> actual licence for the dataset and jurisdiction you intend to use.

---

## Contents

- [Executive summary](#executive-summary)
- [Reference baseline: Finland](#reference-baseline-finland)
- [EU / EEA](#eu--eea)
- [United Kingdom](#united-kingdom)
- [Canada](#canada)
- [United States](#united-states)
- [Pan-regional fallback: OpenStreetMap](#pan-regional-fallback-openstreetmap)
- [Sources ruled out](#sources-ruled-out)
- [Implementation notes](#implementation-notes)
- [Suggested order](#suggested-order)
- [Verification checklist](#verification-checklist)
- [Confidence notes](#confidence-notes)

---

## Executive summary

The Finnish pattern — a single national topographic database carrying power
network features under one open licence — transfers cleanly to roughly **8–10
countries**. Elsewhere a different *class* of source is needed.

| Region | Verdict | Primary source class |
|---|---|---|
| **EU / EEA** | ~10 countries are drop-in replacements | National topographic DB (national mapping agency) |
| **United Kingdom** | The topographic DB is the wrong source; distribution network operator open data is **richer** than Maastotietokanta | DNO open-data portals |
| **Canada** | Closest true analogue to Finland | CanVec (NRCan) |
| **United States** | No suitable open national source available | — |

Three cross-cutting findings shape any implementation:

1. **Only the Netherlands serves native GeoJSON.** Every other source needs
   conversion from GeoPackage, Shapefile, GML, SOSI or Esri FGDB.
2. **The national topographic DB is often not the best power data in a given
   country.** Transmission and distribution operators publish voltage, circuit
   and ownership attributes that topographic databases lack. A two-source model
   (mapping-agency geometry + operator attributes) is the general pattern.
3. **OpenStreetMap is the only uniform pan-regional fallback — and its ODbL
   share-alike licence forces a data-architecture decision that is far easier to
   make before any code is written.** See
   [ODbL and data architecture](#odbl-and-data-architecture).

---

## Reference baseline: Finland

**Maastotietokanta** — Maanmittauslaitos (National Land Survey of Finland).

| Property | Value |
|---|---|
| Licence | Open data, CC BY 4.0 |
| CRS | ETRS-TM35FIN (EPSG:3067); heights N2000 (EPSG:3900) |
| Scale | 1:10 000 |
| Formats | GeoPackage, GML, Shapefile |
| Access | File service — municipality or free-polygon extracts |

- Product page: <https://www.maanmittauslaitos.fi/kartat-ja-paikkatieto/aineistot-ja-rajapinnat/tuotekuvaukset/maastotietokanta>
- GML schema: <http://xml.nls.fi/XML/Schema/Maastotietojarjestelma/MTK/202203/Maastotiedot.xsd>

`gridgen` currently reads the Shapefile distribution from the public Funet
mirror — see [`README.md`](./README.md) for the sheet grid and layer mapping.

> **Migration note:** NLS is migrating Maastotietokanta to the **Kansallinen
> maastotietokanta** (National Topographic Database) and has published a
> **Maastotietojen kyselypalvelu (OGC API Features) beta**. That endpoint would
> serve native GeoJSON for Finland, potentially removing the conversion step at
> source. Worth tracking — it affects the existing pipeline, not just expansion.

---

## EU / EEA

### Tier 1 — drop-in equivalents

Power features confirmed at schema level, open licence, no blocking friction.

| Country | Dataset / Agency | Confirmed power classes | Access | Formats | Licence | CRS |
|---|---|---|---|---|---|---|
| 🇳🇱 NL | **TOP10NL** / Kadaster–PDOK | `hoogspanningsleiding`, `hoogspanningsmast`, `transformatorstation` | **OGC API Features** | **GeoJSON**, JSON-FG, GPKG, GML | CC BY 4.0 | 28992 |
| 🇫🇷 FR | **BD TOPO v3** / IGN | `LIGNE_ELECTRIQUE`, `POSTE_DE_TRANSFORMATION`, `PYLONE` | Bulk + WFS | SHP, GPKG (3D) | Etalab 2.0 | 2154 |
| 🇨🇿 CZ | **ZABAGED** / ČÚZK | Elektrické vedení, Stožár, Rozvodna/transformovna, Elektrárna | Bulk + WFS + ATOM | SHP, DGN, GML | Open ⚠️ | 5514 |
| 🇩🇰 DK | **GeoDanmark** / Datafordeler | `Højspændingsledning`, `Mast` (3D points) | WFS + **change-event feed** | GML, SHP, TAB | Danish public basic data | 25832 |
| 🇵🇱 PL | **BDOT10k** / GUGiK | `SULN01`–`SULN04` (EHV/HV/MV/LV) + substations | Bulk by powiat | GML 3.2 only | Open | 2180 |
| 🇧🇪 BE | **Top10Vector** / NGI | Dedicated "High-voltage network" theme | geo.be + WMS | GPKG, SHP (3D) | CC BY 4.0 | 3812 |
| 🇦🇹 AT | **BEV DLM** (BAUTEN) | `Stromleitung`, `Strommast` | Bulk only — no API | GPKG, SHP | CC BY 4.0 | 31255 |

**Notable characteristics:**

- **Netherlands** — the only source in this survey serving native GeoJSON. No
  conversion, no API key, no registration.
  `https://api.pdok.nl/kadaster/brt-top10nl/ogc/v1/`
- **Poland** — the four-level voltage classification (EHV / HV / MV / LV) is
  *richer* than Finland's. GML-only is the main integration cost; GUGiK ships a
  QGIS plugin (`BDOT_10k_GML_SHP`) for conversion.
- **Denmark** — the change-event feed ("GeoDanmark Vektor Hændelser") is the only
  clean incremental-update mechanism found. Needs a free Datafordeler account.
- **Czechia** — the cleanest schema match to Finland. Catalogue category 3
  "Rozvodné sítě a produktovody", current to 2026-01-01. Catalogue caveat:
  *"Zahrnuje pouze nadzemní části objektů"* (above-ground parts only).
- **France** — RTE publishes transmission assets via ODRÉ but **withdrew precise
  pylon coordinates in 2024** on public-security grounds. BD TOPO's `PYLONE`
  layer remains the open pylon source.
- **Belgium** — ⚠️ the update cycle for non-road themes is **6 years**. NGI
  charges per file for custom reprojection or reformatting; take the standard
  Lambert 2008 GeoPackage and reproject in-pipeline.
- **Austria** — no online API; bulk download only, annual-to-triennial refresh.

### Tier 2 — confirmed content, real friction

| Country | Dataset / Agency | Power features | Licence | CRS | Friction |
|---|---|---|---|---|---|
| 🇩🇪 DE | **ATKIS Basis-DLM** / AdV states | `AX_Leitung`, `AX_Turm` ⚠️ | DL-DE/Zero-2.0 or BY-2.0 | 25832/25833 | See below |
| 🇸🇪 SE | **Topografi 10** / Lantmäteriet | Kraftledning stam/region, Transformatorområde (no pylons) | CC0 ⚠️ | 3006 | Geotorget account |
| 🇳🇴 NO | **N50 Kartdata** / Kartverket | Kraftlinje/kraftspenn, Mast, Tårn | CC BY 4.0 | 25833 | 1:50k generalisation (2–50 m) |
| 🇪🇸 ES | **BTN** / IGN–CNIG | "Energia" theme ⚠️ classes unverified | ≈ CC BY 4.0 | ETRS89 + REGCAN95 UTM | Dual datum |
| 🇪🇪 EE | **ETAK** / Maa- ja Ruumiamet | "Tehnovõrgud" theme ⚠️ classes unverified | Open, attribution | 3301 | **Weekly updates** — best cadence found |

**Germany — key finding:** integration does **not** require 16 Bundesland
portals. <https://basemap.de/open-data/> publishes ATKIS Basis-DLM for all 16
states as one GeoPackage per state in EPSG:4326, refreshed weekly.

⚠️ These are in the *basemap.de data model*, not raw AAA/ATKIS — verify the power
features survive the transformation. If they do not, all 16 states publish raw
Basis-DLM as open data individually (e.g. <https://opengeodata.nrw.de>).

> **Note on the BKG route.** BKG's nationwide Basis-DLM (Ebenen / kompakt) is a
> paid product requiring a signed licence agreement. Its free products
> (DLM250 / DLM1000) are too coarse for distribution-level work.

**Norway caveat:** the detailed **FKB** dataset (including FKB-Ledning, with
individual masts and spans) is **not open** — Kartverket requires purchase via
Geovekst partners. N50 at 1:50 000 may be too coarse; NVE publishes Norwegian
grid infrastructure openly as a better complement.

**Sweden caveat:** ⚠️ could not confirm Topografi 10 is on Lantmäteriet's CC0
open-data list. The EU High-Value Datasets regulation obliges Lantmäteriet to
provide geographic information free of charge (except SWEPOS); Topografi 10's
inclusion was the open question. Verify in Geotorget.

### Tier 3 — leave until later

| Country | Dataset | Blocker |
|---|---|---|
| 🇮🇹 IT | **DBSN** / IGM | **ODbL 1.0 share-alike** — carries the same obligations as OSM, so it must be handled in the same isolated layer. Additionally only 74 of 91 classes are distributed and electricity inclusion is ⚠️ unverified. |
| 🇮🇪 IE | **PRIME2** / Tailte Éireann | Commercial product; the open portal carries only boundaries and the placename gazetteer. Re-use conditions also restrict use *"for the principal purpose of advertising or promoting a particular product or service"*. EirGrid + OSM is the open route. |

### Remaining EU/EEA states — leads, not conclusions

Power-feature content **not verified** for any of these.

| Country | Dataset / Agency | Note |
|---|---|---|
| 🇸🇰 SK | ÚGKK SR — **ZBGIS** | Open, modelled similarly to Czech ZABAGED. Strong candidate. |
| 🇸🇮 SI | GURS — **DTK / GJI** | The **GJI** register explicitly covers energy infrastructure. |
| 🇱🇹 LT | **GDB10LT** | Open since ~2020; likely carries "elektros linija". |
| 🇱🇻 LV | LGIA — **Topo50** | Open data; verify power classes. |
| 🇱🇺 LU | ACT — **BD-L-TC** | Small, open, CC BY. Good testbed. |
| 🇭🇷 HR | DGU — **TTB / CROTIS** | Partially open. |
| 🇮🇸 IS | **IS 50V** | Fully open (CC BY), includes an infrastructure layer. |
| 🇨🇭 CH | swisstopo — **swissTLM3D** | *Outside the stated scope but excellent:* open licence, `TLM_LEITUNG` lines and masts, 3D, GPKG/SHP/GDB, EPSG:2056. |
| PT, GR, HU, RO, BG, CY, MT | Various | No open national topographic vector DB with power features found. |

### Regulatory driver

**EU High-Value Datasets Implementing Regulation (EU) 2023/138** (in force
2023-02-09, compliance deadline 2024-06-09) is why many of these datasets became
free. Belgium's NGI states this explicitly and tags Top10Vector
`HVD_cat_energy_resources`; Germany's GovData tags Basis-DLM as HVD.

Where a country still charges, the HVD regulation is a legitimate thing to cite.
The flip side, which NGI is candid about: several mapping agencies are complying
while under-resourced, so open-data refresh cadence can lag the paid product.

---

## United Kingdom

The UK inverts the Finnish model. The topographic database is the *weaker*
source; the network operators publish better data. Expect several adapters
rather than one.

### Regulatory context

**Ofgem Data Best Practice Guidance** (v3.5, 2025-11-17) is a **licence
condition**, not guidance. It binds RIIO-GD2/T2/ED2 licensees: NESO, DNOs,
electricity transmission owners and gas transporters. The sector operates on a
**"presumed open"** principle, with a formal Open Data Triage process run by the
ENA Data & Digitalisation Steering Group. Where data can be opened it "should be
made available under one of two recognised open licences: **Creative Commons
Attribution 4.0 or the Open Government Licence**."

In January 2026 Ofgem extended these obligations to the Smart Meter
Communication Licence, with further code-body expansion signalled. This data is
mandated and expanding — but fragmented by design.

### Distribution network operators — the highest-value UK source

**UK Power Networks** (EPN/LPN/SPN) is the standout. Datasets confirmed via
their official Python client `ukpyn`:

| Dataset | Content |
|---|---|
| `hv_overhead_lines` | HV overhead line routes (11 kV) |
| `lv_overhead_lines` | LV overhead line routes (400 V) |
| `hv_poles` | HV pole locations |
| `lv_poles` | LV pole locations |
| `primary_substations` | Primary substation areas |
| `secondary_sites` | Secondary distribution substation locations |

Provenance is stated plainly: *"Shapefiles are extracted from our geospatial
mapping system — NetMap."* This is **operator-authoritative asset data, not a
cartographic derivative**. Native GeoJSON export, Opendatasoft Explore API
v2.1, shapefile download, free registration, API key via `UKPN_API_KEY`.

⚠️ **The exact licence instrument could not be retrieved.** Sector context
suggests CC BY 4.0 or OGL. Confirm before building on it.

**Other operators:**

| Operator | Portal | Confirmed content |
|---|---|---|
| **NGED** | `connecteddata.nationalgrid.co.uk` | 11 kV & 132 kV overhead lines (SHP/DWG/DGN); GSP/BSP/primary supply-area polygons (GPKG). **API token required since 2024-06-01.** |
| **SP Energy Networks** | `spenergynetworks.opendatasoft.com` | Distribution **and** transmission (SPEN is also a transmission owner in Scotland). Separate Open and Shared Data Licences plus a Data Triage record. |
| **Electricity North West** | `electricitynorthwest.opendatasoft.com` | Substations, power lines, cables; ~28+ datasets. ⚠️ conductor geometry unconfirmed. |
| **Northern Powergrid** | `northernpowergrid.opendatasoft.com` | `ltds_ehv_sites` (all EHV operational sites, updated May/Nov). ⚠️ conductor geometry unconfirmed. |
| **SSEN** | `data.ssen.co.uk` | Substation data with coordinates. The full network GIS is **Electric Office** — login-gated, ~2 working days for approval. The most closed of the GB DNOs. |
| **NIE Networks** | `nienetworks.opendatasoft.com` | Northern Ireland, transmission and distribution. Contains OSNI information under **OGL v3.0**. Needs a separate pipeline branch (Irish Grid / ITM, not OS GB). |

### Ordnance Survey

| Product | Power content | Licence |
|---|---|---|
| **OS Open Zoomstack** | `ETL` — Electricity Transmission Lines | **Free, OpenData Plan.** Generalised cartographic basemap: no pylons, no voltage. Refreshed twice yearly. |
| **OS MasterMap Topography** | **Pylons as individual features** | Premium / PSGA. ~500M objects, EPSG:27700. |
| **OS NGD Structures** | ⚠️ Documented scope omits pylons | Premium / PSGA. Verify the Structure Point `description` code list before scoping. |

### ⚠️ Licence trap — National Grid Electricity Transmission

NGET publishes transmission shapefiles (**Substation, Site, Over Head Line,
Cables, Towers**) at
`nationalgrid.com/electricity-transmission/network-and-infrastructure/network-route-maps`.

That is exactly the feature set wanted, but the terms are narrow:

> *"These datasets are for indicative purposes only. They can only be used for
> emergency and land use planning and cannot be used for commercial purposes."*

Do not put this into a pipeline without checking the terms against your intended
use. Note this is a **distinct entity** from **NGED** (National Grid Electricity
*Distribution*) above — the two are easy to conflate.

### NESO

`neso.energy/data-portal` — **GIS Boundaries for GB Grid Supply Points**, in
Shapefile/GeoJSON, EPSG:27700, NESO Open Data Licence, CKAN API at
`api.neso.energy`. GSP IDs are registered with Elexon, which lets DNO data join
to settlement data.

⚠️ **Scoping note:** these are Thiessen-polygon-derived *service regions*, not
network geometry. Excellent for regional aggregation; not a substitute for
circuit geometry. NESO does not publish transmission line or tower geometry.

---

## Canada

### CanVec — the closest analogue to Maastotietokanta

**"Mines, Energy and Communication Networks in Canada — CanVec Series —
Resources Management Features"**, Natural Resources Canada.

Confirmed content: **power lines, transformer stations**, communication lines,
pipelines, valves, petroleum wells, wind-operated devices, extraction sites.
Record keywords include *"Electrical grid"*.

| Property | Value |
|---|---|
| Licence | **Open Government Licence – Canada** (attribution required) |
| Formats | File Geodatabase (FGDB), Shapefile, KMZ index |
| Bulk | `ftp.maps.canada.ca/pub/nrcan_rncan/vector/canvec/fgdb/Res_MGT/` — no auth, scriptable |
| WMS | `maps.geogratis.gc.ca/wms/canvec_en?...&layers=resource_management` |
| Extract tool | `maps.canada.ca/czs/` |
| CRS | ⚠️ Not stated on the record. Typically NAD83(CSRS) / EPSG:4617 — **verify from the FGDB.** |

⚠️ **Maintenance flag:** the record shows **"Maintenance and Update Frequency:
Not Planned"** and **"Status: Completed"**, original publication 2019-03-01
(record touched 2025-12-22). Treat CanVec as a stable baseline, not a live feed.

Federal discovery also runs through `open.canada.ca` and the `geo.ca` browser,
which harvests provincial records into one catalogue.

### Provincial

| Province | Dataset | Content | Licence | Access |
|---|---|---|---|---|
| **BC** | `GBA_TRANSMISSION_LINES_SP` / GeoBC | HV lines from BC Hydro, IPPs, TRIM | OGL – British Columbia | BCGW download, **WMS**, KML |
| **AB** | **Powerlines** / AB EPA | >69 kV corridors, 2,387 objects. *"The authoritative source of powerline data for the province."* | OGL – Alberta | **Esri REST** |
| **ON** | **Utility Line** / Geospatial Ontario | Hydro lines + submerged hydro lines | ⚠️ Licence conflict | Esri REST, SHP, FGDB, GeoJSON |
| **QC (Montréal)** | **Lignes de transport électrique** / Ville de Montréal | **Pylon bases + aerial cable**, ±30–40 cm planimetric | CC BY 4.0 | GPKG, SHP |

**Flags:**

- **BC** — *"Voltage information is not currently available on the public version
  of this dataset as per publication agreement with BC Hydro."* Geometry open,
  the key electrical attribute withheld. Expect this compromise repeatedly.
- **Alberta** — EPSG:3400 (NAD83 / Alberta 10-TM Forest). Distribution-level
  assets (poles, conductors) are not in the open dataset.
- **Ontario** — ⚠️ **quality is poor.** Only 5,612 records province-wide, data
  range **1977–2008**, sample rows dominated by `CLASS_SUBTYPE = "Unknown
  Pipeline"` with 1998 verification timestamps. Also a licence discrepancy:
  GeoHub shows "Custom License", data.ontario.ca shows OGL – Ontario. Ontario's
  operational grid data sits with IESO and Hydro One, neither of which publishes
  open network geometry.
- **Quebec** — Hydro-Québec's open data portal covers outages, line-clearing
  works and generation sources. ⚠️ **No open transmission line geometry found**;
  HQ states access is licence-framed *"par mesure de sécurité"*. This is a
  negative finding from the portal description — verify by direct catalogue
  crawl. The Montréal municipal dataset is excellent quality but municipal
  extent only.

---

## United States

**No suitable open national source is available.**

---

## Pan-regional fallback: OpenStreetMap

The only uniform source spanning the surveyed regions under one schema.

### Tagging scheme

| Tag | Geometry | Meaning |
|---|---|---|
| `power=line` | way | HV overhead transmission line |
| `power=minor_line` | way | Distribution-level line |
| `power=cable` | way | Underground / submarine cable |
| `power=tower` | node | Lattice / steel HV pylon |
| `power=pole` | node | Distribution pole |
| `power=substation` | node / area | Qualified by `substation=transmission\|distribution\|traction` |
| `power=generator` / `power=plant` | node / area | Generating unit / plant site |
| `power=transformer`, `power=switch`, `power=portal`, `power=terminal` | node | Substation internals |

Key attributes: `voltage` (volts, semicolon-separated for multi-circuit),
`circuits`, `cables`, `frequency` (`0` = HVDC, `16.7` = traction), `operator`,
`ref`, `location`.

**Topological limitation:** OSM provides geometry plus a node/way graph, but
**not an electrically connected network**. Lines terminate at towers, not
substation busbars; line→substation incidence must be inferred by spatial join.
This is the gap the derived datasets below exist to fill — and the same
`RadialNetwork` closure `gridgen` builds would need that inference first.

### Coverage

OpenInfraMap global totals: **7,494,568 km of power lines**, ~1M substations,
~125k power plants. **15.1% of line length has no voltage tagged.**

Regional ranking (high confidence in the ordering):

1. **EU** — best in the world for transmission; Germany near-exhaustive at tower level
2. **UK** — strong transmission; distribution below 33 kV patchy
3. **Canada** — sparse outside the Windsor–Québec corridor and the BC lower mainland

OSMF's own caveat: *"in many countries, this is not a complete depiction of the
electricity network, and these statistics should be used with caution."*

### Tooling

| Tool | Use |
|---|---|
| **Geofabrik** | Daily per-country `.osm.pbf` extracts — the correct bulk ingestion path |
| **Overpass API** | Live query; ideal for development and small areas. Rate-limited |
| **ohsome API / OSHDB** (HeiGIT) | Exposes **full OSM history** — compute per-region time series to detect whether mapping has saturated (implies completeness) or is still climbing (implies gaps). The most defensible way to produce a per-country completeness score |
| **Osmose** | QA service with a dedicated power analyser — flags broken connectivity, towers not on lines, missing voltage |
| **osmium-tool / osm2pgsql / PyrOSM** | PBF filtering and PostGIS loading |
| **OpenInfraMap** (openinframap.org) | Canonical rendering; fastest visual completeness check; per-country stats |

### Derived / research datasets

| Dataset | Content | Licence | Verdict |
|---|---|---|---|
| **PyPSA-Eur** | Prebuilt European transmission network, ~33–36 countries, with lines, HVDC links, buses, transformers **and electrical parameters**. OSM IDs preserved | Code MIT/GPL; data CC BY 4.0 — **ODbL flows through** | ✅ Best geometry + topology + parameters bundle for Europe |
| **PyPSA-Earth** | Global generalisation, same toolchain | Open; ODbL flows through | ✅ Natural route beyond Europe. Validate per country |
| **Xiong et al.**, arXiv:2408.17178 | Cleaned/validated European network from OSM. Documents voltage inference, deduplication, line–substation snapping, multi-circuit reconciliation, traction filtering | Open / research | ✅ **Read for methodology even if not ingesting.** Effectively the specification for the untagged-voltage and topology-inference problems |
| **WRI Global Power Plant Database** | ~35,000 plants: capacity, fuel, ownership, geolocation | **CC BY 4.0** — no share-alike | ✅ Generation layer, outside the ODbL problem |
| **Global Energy Monitor** | Plant trackers, strong on **under-construction and planned** assets | **CC BY 4.0** | ✅ Best forward-looking source; complements WRI |
| **SciGRID** | Progenitor European model from OSM | Open (Apache 2.0) | ❌ Superseded by PyPSA-Eur |
| **GridKit** | OSM→network extraction toolkit | Open | ❌ Dormant; outputs stale |
| **gridfinder** | **Predicts** MV/LV routes from night-time lights + least-cost path | Open (MIT / CC BY 4.0) | ❌ *Predicted*, not observed geometry — not appropriate where real data exists |

> ⚠️ **CC BY 4.0 on a derived output does not remove ODbL.** PyPSA-Eur,
> PyPSA-Earth, Xiong, SciGRID and GridKit all inherit OSM's obligations and
> belong in the OSM-derived layer. WRI and GEM are independently compiled and do
> not.

### ODbL and data architecture

**This decision is much easier to make before code is written than to retrofit
after data has been conflated.**

OSM is licensed **ODbL v1.0** — copyleft for databases. Three categories
determine the outcome:

| Category | Definition | Obligation |
|---|---|---|
| **Produced Work** (§4.3) | A work *produced from* the database that is not itself a database — a rendered map, tile, report or dashboard view | **Attribution only.** No share-alike |
| **Derivative Database** (§4.4) | A database *based upon* OSM — modified, transformed, adapted, built upon | **Must be published under ODbL** in machine-readable form |
| **Collective Database** (§4.5(a)) | OSM *together with* independent databases, **kept separate and not merged** | **Exemption preserved.** The other databases need not be ODbL-licensed |

**§4.5(a) is the operative provision: assembly ≠ derivation; merging =
derivation.** In practice the distinction is **spatial/logical separation versus
attribute-level fusion**:

- Writing non-OSM attributes onto an OSM feature record, or persisting merged
  OSM + non-OSM geometry → **Derivative Database.** Share-alike applies.
- Keeping OSM features in their own tables with their own provenance, joining to
  other tables at query or render time → **Collective Database.**

A spatial join at *render* time producing a map image is fine — the output is a
Produced Work. A spatial join *persisted back into a distributed database*
creates the derivative.

> **Architectural rule**
>
> Keep OSM in its own physically separate, ODbL-labelled layer with full
> provenance tagging. Never write non-OSM attributes onto an OSM-derived feature
> record. Never persist merged OSM + non-OSM geometry into a distributed
> database. Combine only (a) at render/report time, yielding Produced Works that
> carry attribution only, or (b) as co-located but unmerged tables under
> §4.5(a). Anything *inferred* from OSM (voltage, topology) is itself
> ODbL-derived and belongs in the OSM layer.

**Two corollaries:**

- **Attribution is unconditional.** "© OpenStreetMap contributors" must appear on
  every rendered view and export. Build it into the render layer so it cannot be
  omitted.
- **Distribution, not internal analysis, is the trigger.** Check where your
  outputs actually go before assuming an internal-use carve-out applies.

⚠️ **This is not legal advice.** The three-way distinction is well established;
its application to hosted services has been genuinely debated. The rule above is
deliberately conservative so it survives a stricter reading. Take proper advice
before relying on it.

**Reference implementation worth copying:** the Overture Maps Foundation
segregates by provenance — CDLA-Permissive-2.0 where it can, ODbL where content
is OSM-sourced, with per-feature source tagging. Their **GERS** stable-identifier
scheme is also relevant to joining OSM features to other asset records across
releases. ⚠️ Overture has discussed a utility/infrastructure theme but there is
**no shipped production electricity-network theme** — re-check release notes.

---

## Sources ruled out

| Source | Reason |
|---|---|
| **ENTSO-E** | The Transparency Platform is **market/time-series data**, not geometry. The Interactive Transmission System Map is a **viewer only** — no bulk download, no redistribution licence. **Still useful** for bidding-zone, interconnector-capacity and flow attributes joined to geometry from elsewhere. |
| **INSPIRE** | Annex III "Utility and Governmental Services" (`US.ElectricityNetwork_UtilityLink`) is legally mandated and well designed — but among the **least-implemented themes**. Many states publish metadata records satisfying discoverability audits with no actual features; coverage is discontinuous at borders; Luxembourg is essentially the only live conformant example ⚠️. **Still useful:** adopt the INSPIRE Utility Networks data model as the internal canonical schema. It costs nothing and is standards-based. |
| **Copernicus / EU-DEM / CORINE** | Terrain and land cover — no power network content |

### Useful catalogue

**"Awesome Electrical Grid Mapping"** — a community-maintained GitHub catalogue
of open datasets, tools, papers and services for grid mapping, including
national TSO/DSO open-data portals with licence tags. ⚠️ Licence is CC0 or
CC BY — check the repo LICENSE file.

**Recommended use:** treat it as the **per-country source-discovery checklist**.
When adding a country, look here for a national open source before defaulting to
OSM-derived geometry.

---

## Implementation notes

1. **Format conversion is unavoidable except for the Netherlands.** Sources span
   GeoPackage (best), Shapefile, GML 3.2, SOSI and Esri FGDB. A GDAL/`ogr2ogr`
   based converter handles all of them. `gridgen` already reads Shapefile via
   GeoPandas, so the GeoPackage countries are the smallest step.

2. **Thirteen distinct native CRSs** across Tier 1 and 2 alone: 28992, 2154,
   5514, 25832, 2180, 3812, 31255, 3006, 25833, 3301, plus 27700 (UK), 4617
   (Canada) and 3400 (Alberta). **Build reprojection once, config-driven per
   country — not per-country code.** `gridgen` already isolates this: the target
   CRS is a config value, not a constant.

3. **Adopt a two-source model.** The national mapping agency supplies
   survey-accurate *geometry* (lines, pylons, substation footprints); the
   TSO/DSO supplies *electrical attributes* (voltage, circuits, ownership).
   Nearly every European TSO now publishes openly: RTE (FR), Energinet (DK),
   Svenska kraftnät (SE), NVE (NO), TenneT/50Hertz/Amprion/TransnetBW (DE),
   Terna (IT), REE (ES), PSE (PL), ČEPS (CZ), APG (AT), Elia (BE), TenneT (NL),
   Fingrid (FI), EirGrid (IE).

4. **Security-driven withdrawal is a live risk.** RTE removed precise pylon
   coordinates in 2024 on public-security grounds; BC withholds voltage per
   agreement with BC Hydro; Hydro-Québec frames access *"par mesure de
   sécurité"*. National topographic databases have so far been unaffected — an
   argument for preferring them over operator feeds for geometry, and for
   archiving a snapshot of whatever is ingested.

5. **Build data-quality telemetry from day one.** The 15.1% untagged-voltage
   figure and Ontario's 1977–2008 data range are product problems, not just data
   problems. Surface per-region confidence (ohsome currentness, Osmose
   power-topic issues, OpenInfraMap stats) rather than silently interpolating.

6. **Track the Finnish migration.** The Kansallinen maastotietokanta transition
   and the OGC API Features beta affect the existing pipeline independently of
   any expansion.

---

## Suggested order

**Highest confidence, fastest** — Netherlands → France → Czechia → Denmark →
**Canada**. All have confirmed line + pylon + substation classes and open
licences. The Netherlands needs no format conversion at all; Canada reuses the
existing converter most directly with the cleanest licence (OGL–Canada, plain
FTP bulk).

**Largest markets, moderate effort** — Germany (via basemap.de, after verifying
power survives the model transformation) → Poland (GML) → **United Kingdom**.
For the UK, start with OS Open Zoomstack `ETL` for a free national transmission
backbone, then add UK Power Networks for genuine distribution depth (poles,
towers, native GeoJSON, official Python client), then NGED, SPEN, ENWL, Northern
Powergrid, SSEN and NIE incrementally.

**Then** — Spain → Sweden → Norway → Austria → Belgium → Estonia.

**Leave until later** — Italy (ODbL plus unverified content) and Ireland (not
open; EirGrid + OSM is the route).

---

## Verification checklist

Items requiring confirmation before implementation.

### Blocking

- [ ] **UK Power Networks licence text** — the exact instrument (CC BY 4.0? OGL? bespoke?). Blocks the UK distribution plan
- [ ] **OS NGD Structure Point `description` code list** — does `Pylon` survive from MasterMap? Blocks any NGD-based UK plan
- [ ] **ODbL architecture** — confirm the Collective Database reading for your intended distribution model

### High priority

- [ ] **Germany** — do power features survive the basemap.de model transformation? If not, fall back to per-state raw Basis-DLM
- [ ] **Sweden** — is Topografi 10 on Lantmäteriet's CC0 open-data list?
- [ ] **CanVec CRS** — confirm from the FGDB, not the catalogue record

### Secondary

- [ ] **Czechia** — read the ZABAGED open-data licence text
- [ ] **Italy** — are electricity classes among DBSN's 74 distributed classes?
- [ ] **Spain** — enumerate BTN "Energia" theme feature classes (spec: <https://www.ign.es/resources/docs/IGNCnig/BTN/ESPBTN.pdf>, catalogue from p.15)
- [ ] **Estonia** — enumerate ETAK "Tehnovõrgud" classes. The 2.8 MB national file suggests transmission-only
- [ ] **Germany** — verify `AX_Leitung` BWF/Bauwerksfunktion value codes for Freileitung/Hochspannungsleitung
- [ ] **ENWL / Northern Powergrid / SPEN** — confirm conductor *line* geometry (not just substation points) is downloadable
- [ ] **Ontario** — resolve the licence conflict (GeoHub "Custom License" vs data.ontario.ca OGL–Ontario)
- [ ] **Hydro-Québec** — confirm the negative finding on network geometry via direct catalogue crawl
- [ ] **Overture** — re-check release notes for an infrastructure/utility theme

### Cheap de-risking

- [ ] Diff an OSM extract for Finland against the current Maastotietokanta output.
      Finland is the one country where ground truth already exists, so this turns
      "OSM is probably good enough" into a measured gap analysis.

---

## Confidence notes

- **Verified against live sources:** Netherlands (API response), Czechia (object
  catalogue), Denmark (Grunddatamodel), UKPN dataset list (`ukpyn` client), NGET
  licence terms, Alberta and BC dataset records, OpenInfraMap global statistics.
- **Inferred from documentation, not live data:** German `AX_Leitung` value
  codes, Spanish BTN class list, Estonian ETAK class list, Italian DBSN class
  distribution.
- **Reconstructed / lower confidence:** some OSM regional coverage figures and
  the PyPSA-Eur country count (sources gave 33 and 36 in different passes). The
  15.1% untagged-voltage figure is from OpenInfraMap and is the reliable one;
  treat other percentage claims as indicative until re-verified.
