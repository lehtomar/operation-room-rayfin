"""mmlsource — download and read MML open data for *any* Finnish municipality.

`gridgen` used to require a hand-downloaded Maastotietokanta map sheet sitting in
`mml-data/<SHEET>/`, which capped the grid at whatever that one sheet covered
(Sysmä was clipped at its southern edge). This module removes that limit:

1. **Resolve the municipality** against the national municipality division
   (`SuomenKuntajako_<year>_10k`) — the true, unclipped polygon for any of the
   ~309 Finnish kunnat, by Finnish/Swedish name or by kunta code.
2. **Work out which map sheets cover it** using the official ETRS-TM35FIN sheet
   division (JHS 197), implemented analytically in `tile_bounds`.
3. **Download exactly those sheets** from the public Funet mirror of MML open
   data (no API key), cached on disk so re-runs are free.
4. **Serve the layers gridgen needs** (buildings, roads, electrical points),
   merged across sheets and clipped to the municipality.

Sheet division (verified against real MML tile extents)
-------------------------------------------------------
Level 1 sheets are 192 km (E) x 96 km (N), addressed `<row letter><column>`,
origin at E=-76000, N=6570000. Each level is quartered; quadrant digits are
**column-major, south-to-north**: 1=SW, 2=NW, 3=SE, 4=NE. The final `L`/`R`
suffix splits the 24x12 km sheet into two 12x12 km halves (L=west, R=east).
`M4411R` therefore resolves to E 416000-428000, N 6810000-6822000.

Data sources (both public, both CC BY 4.0 by Maanmittauslaitos)
---------------------------------------------------------------
- Maastotietokanta (topographic database), shapefile, 1:10 000
- Kuntajako (municipality division) 1:10 000
"""

from __future__ import annotations

import shutil
import time
import unicodedata
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

import geopandas as gpd
import pandas as pd
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

TM35FIN = "EPSG:3067"

FUNET_BASE = "https://www.nic.funet.fi/index/geodata/mml"
DEFAULT_MTK_YEAR = "2025"
DEFAULT_KUNTAJAKO_YEAR = "2025"
USER_AGENT = "operations-room-gridgen/1.0 (+https://github.com/lehtomar/operation-room-rayfin)"

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CACHE_DIR = REPO_ROOT / "mml-data" / "cache"

# --------------------------------------------------------------------------
# ETRS-TM35FIN map sheet division (JHS 197)
# --------------------------------------------------------------------------
ROW_LETTERS = "KLMNPQRSTUVWX"  # south -> north; I and O are skipped by design
COLUMNS = range(2, 7)  # west -> east
GRID_ORIGIN_E = -76_000
GRID_ORIGIN_N = 6_570_000
LEVEL1_W = 192_000
LEVEL1_H = 96_000

#: Length of a sheet name at each subdivision level. The MML shapefile
#: distribution is published at level 6 (the 12x12 km L/R half sheets).
SHEET_LEVELS = {2: "1:200 000", 3: "1:100 000", 4: "1:50 000", 5: "1:25 000", 6: "1:10 000"}
DISTRIBUTION_LEVEL = 6


def tile_bounds(tile: str) -> tuple[float, float, float, float]:
    """Return the ``(minx, miny, maxx, maxy)`` extent of a map sheet in TM35FIN."""
    name = tile.strip().upper()
    if len(name) < 2 or name[0] not in ROW_LETTERS or not name[1].isdigit():
        raise ValueError(f"not a TM35FIN map sheet name: {tile!r}")
    column = int(name[1])
    if column not in COLUMNS:
        raise ValueError(f"map sheet column out of range in {tile!r}")

    east = float(GRID_ORIGIN_E + (column - COLUMNS.start) * LEVEL1_W)
    north = float(GRID_ORIGIN_N + ROW_LETTERS.index(name[0]) * LEVEL1_H)
    width, height = float(LEVEL1_W), float(LEVEL1_H)

    for ch in name[2:]:
        if ch in "1234":
            width /= 2
            height /= 2
            quadrant = int(ch) - 1
            east += (quadrant // 2) * width  # 1,2 = west column; 3,4 = east
            north += (quadrant % 2) * height  # 1,3 = south row;  2,4 = north
        elif ch in "LR":
            width /= 2
            if ch == "R":
                east += width
        else:
            raise ValueError(f"unexpected character {ch!r} in map sheet name {tile!r}")
    return (east, north, east + width, north + height)


def _subdivide(tile: str) -> list[str]:
    if len(tile) < 5:
        return [tile + d for d in "1234"]
    if len(tile) == 5:
        return [tile + h for h in "LR"]
    return []


def _overlaps(a: Sequence[float], b: Sequence[float]) -> bool:
    # Strict comparison so sheets that merely touch the bbox edge are excluded.
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


def tiles_covering(
    bounds: Sequence[float], level: int = DISTRIBUTION_LEVEL
) -> list[str]:
    """All map sheet names at ``level`` whose extent overlaps ``bounds``."""
    if level not in SHEET_LEVELS:
        raise ValueError(f"level must be one of {sorted(SHEET_LEVELS)}, got {level}")
    frontier = [
        t
        for t in (f"{row}{col}" for row in ROW_LETTERS for col in COLUMNS)
        if _overlaps(tile_bounds(t), bounds)
    ]
    found: list[str] = []
    while frontier:
        nxt: list[str] = []
        for tile in frontier:
            if len(tile) >= level:
                found.append(tile)
                continue
            nxt.extend(c for c in _subdivide(tile) if _overlaps(tile_bounds(c), bounds))
        frontier = nxt
    return sorted(found)


def tile_url(tile: str, year: str = DEFAULT_MTK_YEAR) -> str:
    """Public download URL for a Maastotietokanta shapefile map sheet."""
    name = tile.strip().upper()
    if len(name) != DISTRIBUTION_LEVEL:
        raise ValueError(
            f"MML publishes shapefiles at level {DISTRIBUTION_LEVEL} sheets "
            f"(e.g. M4411R); got {tile!r}"
        )
    return f"{FUNET_BASE}/maastotietokanta/{year}/shp/{name[:2]}/{name[:3]}/{name}.shp.zip"


# --------------------------------------------------------------------------
# Layer catalogue
# --------------------------------------------------------------------------
# MML ships each sheet as themed shapefiles named `<theme>_<SHEET>_<kind>.shp`:
#   theme  h=admin  j=utility networks  k=elevation  l=transport
#          m=terrain/nature  n=water  o=names  r=buildings  s=protected areas
#   kind   p=area (pinta)  v=line (viiva)  s=point (piste)  t=text
# Features are typed by the numeric `LUOKKA` (feature class) attribute.
@dataclass(frozen=True)
class LayerSpec:
    theme: str
    kind: str
    #: Inclusive ``(low, high)`` LUOKKA ranges; empty means "keep everything".
    ranges: tuple[tuple[int, int], ...] = ()
    description: str = ""

    def matches(self, luokka: pd.Series) -> pd.Series:
        if not self.ranges:
            return pd.Series(True, index=luokka.index)
        keep = pd.Series(False, index=luokka.index)
        for lo, hi in self.ranges:
            keep |= luokka.between(lo, hi)
        return keep


#: Building feature classes that get a käyttöpaikka. MML numbers buildings
#: 422xx by use (11=residential, 21=commercial/public, 31=holiday home,
#: 41=industrial, 51=ecclesiastical, 61=outbuilding, 70=other); the trailing
#: digit is the representation. Outbuildings (4226x) are deliberately excluded.
BUILDING_CLASSES = ((42200, 42259), (42270, 42299))


LAYERS: dict[str, LayerSpec] = {
    "boundaries": LayerSpec("h", "p", ((84200, 84200),), "municipality areas"),
    # Buildings 422xx, minus 4226x "talousrakennus" (sheds, saunas, garages):
    # an outbuilding shares its main building's connection, so counting them
    # would inflate käyttöpaikat several-fold.
    "buildings": LayerSpec("r", "p", BUILDING_CLASSES, "building footprints"),
    "building_points": LayerSpec("r", "s", BUILDING_CLASSES, "buildings mapped as points"),
    "roads": LayerSpec("l", "v", ((12100, 12199),), "road centrelines (Tie)"),
    "power_lines": LayerSpec("j", "v", ((22300, 22399),), "power lines (Sähkölinja)"),
    # 22200 = Sähköasema/muuntaja. MML maps these as short outlines rather than
    # points, so they live in the line file and are reduced to a point on load.
    "power_points": LayerSpec("j", "v", ((22200, 22200),), "electrical stations"),
}

#: Layer names in the older, per-100k-sheet MML distribution that ships
#: descriptively named shapefiles (`M44_RakennusPiste.shp`) instead of themed
#: ones. Kept so pre-existing local downloads still work.
LEGACY_LAYER_FILES = {
    "boundaries": "HallintoAlue",
    "buildings": None,
    "building_points": "RakennusPiste",
    "roads": "TieViiva",
    "power_lines": "SahkoLinja",
    "power_points": "SahkoPiste",
}


def slugify(name: str) -> str:
    """`Sysmä` -> `sysma`; used for config file + output directory names."""
    decomposed = unicodedata.normalize("NFKD", name)
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    return "".join(c.lower() if c.isalnum() else "-" for c in ascii_only).strip("-")


# --------------------------------------------------------------------------
# Download + cache
# --------------------------------------------------------------------------
def _human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


class DownloadError(RuntimeError):
    pass


def _download(url: str, dest: Path, *, retries: int = 3, quiet: bool = False) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=120) as response, tmp.open("wb") as fh:
                shutil.copyfileobj(response, fh, length=1 << 20)
            tmp.replace(dest)
            if not quiet:
                print(f"[mml]   downloaded {dest.name} ({_human(dest.stat().st_size)})")
            return dest
        except urllib.error.HTTPError as exc:
            tmp.unlink(missing_ok=True)
            if exc.code == 404:
                raise DownloadError(f"404 Not Found: {url}") from exc
            last = exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            tmp.unlink(missing_ok=True)
            last = exc
        if attempt < retries:
            time.sleep(2 * attempt)
    raise DownloadError(f"failed to download {url}: {last}")


@dataclass
class MmlMirror:
    """Cached access to MML open data on the public Funet mirror."""

    cache_dir: Path = DEFAULT_CACHE_DIR
    mtk_year: str = DEFAULT_MTK_YEAR
    kuntajako_year: str = DEFAULT_KUNTAJAKO_YEAR
    quiet: bool = False
    _kuntajako: gpd.GeoDataFrame | None = field(default=None, repr=False)

    def _log(self, message: str) -> None:
        if not self.quiet:
            print(message)

    # -- municipality division ------------------------------------------------
    def kuntajako_path(self) -> Path:
        stem = f"SuomenKuntajako_{self.kuntajako_year}_10k"
        target = self.cache_dir / "hallintorajat" / self.kuntajako_year / f"{stem}.shp"
        if not target.exists():
            self._log(f"[mml] fetching municipality division {self.kuntajako_year}")
            base = f"{FUNET_BASE}/hallintorajat_10k/{self.kuntajako_year}/{stem}"
            for ext in ("shp", "shx", "dbf", "prj"):
                _download(f"{base}.{ext}", target.with_suffix(f".{ext}"), quiet=self.quiet)
        return target

    def kuntajako(self) -> gpd.GeoDataFrame:
        if self._kuntajako is None:
            gdf = gpd.read_file(self.kuntajako_path())
            if gdf.crs is None:
                gdf = gdf.set_crs(TM35FIN)
            self._kuntajako = gdf.to_crs(TM35FIN)
        return self._kuntajako

    def municipalities(self) -> pd.DataFrame:
        gdf = self.kuntajako()
        return pd.DataFrame(
            {
                "code": gdf["NATCODE"].astype(str),
                "name": gdf["NAMEFIN"].astype(str),
                "name_swe": gdf["NAMESWE"].astype(str),
                "land_area_km2": gdf["LANDAREA"],
            }
        ).sort_values("name", ignore_index=True)

    def find_municipality(self, query: str) -> "Municipality":
        """Resolve a municipality by kunta code, Finnish name or Swedish name."""
        gdf = self.kuntajako()
        needle = query.strip().casefold()
        code = gdf["NATCODE"].astype(str).str.lstrip("0").str.casefold()
        fin = gdf["NAMEFIN"].astype(str).str.casefold()
        swe = gdf["NAMESWE"].astype(str).str.casefold()

        exact = gdf[(code == needle.lstrip("0")) | (fin == needle) | (swe == needle)]
        hits = exact if not exact.empty else gdf[fin.str.startswith(needle) | swe.str.startswith(needle)]
        if hits.empty:
            raise LookupError(
                f"no Finnish municipality matches {query!r}; "
                "try `gridgen municipalities --search <text>`"
            )
        if len(hits) > 1:
            names = ", ".join(sorted(hits["NAMEFIN"].astype(str)))
            raise LookupError(f"{query!r} is ambiguous — matches: {names}")
        row = hits.iloc[0]
        return Municipality(
            code=str(row["NATCODE"]),
            name=str(row["NAMEFIN"]),
            name_swe=str(row["NAMESWE"]),
            land_area_km2=float(row["LANDAREA"]),
            geometry=row.geometry,
        )

    # -- topographic database sheets -----------------------------------------
    def tile_archive(self, tile: str, *, refresh: bool = False) -> Path:
        dest = self.cache_dir / "maastotietokanta" / self.mtk_year / f"{tile}.shp.zip"
        if refresh:
            dest.unlink(missing_ok=True)
        if not dest.exists():
            _download(tile_url(tile, self.mtk_year), dest, quiet=self.quiet)
        return dest

    def tile_dir(self, tile: str, *, refresh: bool = False) -> Path:
        archive = self.tile_archive(tile, refresh=refresh)
        target = self.cache_dir / "tiles" / self.mtk_year / tile
        marker = target / ".extracted"
        if refresh or not marker.exists():
            shutil.rmtree(target, ignore_errors=True)
            target.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(target)
            marker.write_text(archive.name, encoding="utf-8")
        return target

    def fetch_tiles(self, tiles: Iterable[str], *, refresh: bool = False) -> list[str]:
        """Download+extract sheets, skipping those MML does not publish (sea)."""
        available: list[str] = []
        wanted = list(tiles)
        for index, tile in enumerate(wanted, start=1):
            self._log(f"[mml] sheet {index}/{len(wanted)}: {tile}")
            try:
                self.tile_dir(tile, refresh=refresh)
            except DownloadError as exc:
                if "404" in str(exc):
                    self._log(f"[mml]   {tile} is not published (no land data) — skipped")
                    continue
                raise
            available.append(tile)
        if not available:
            raise DownloadError("none of the required map sheets could be downloaded")
        return available

    # -- layer access ---------------------------------------------------------
    def read_layer(
        self,
        layer: str,
        tiles: Sequence[str],
        *,
        bbox: Sequence[float] | None = None,
    ) -> gpd.GeoDataFrame:
        spec = LAYERS[layer]
        frames: list[gpd.GeoDataFrame] = []
        for tile in tiles:
            path = self.tile_dir(tile) / f"{spec.theme}_{tile}_{spec.kind}.shp"
            if not path.exists():
                continue  # sheet simply has no features of this theme
            gdf = gpd.read_file(path, bbox=tuple(bbox) if bbox is not None else None)
            if gdf.empty:
                continue
            if "LUOKKA" in gdf.columns:
                gdf = gdf[spec.matches(gdf["LUOKKA"])]
            if gdf.empty:
                continue
            frames.append(gdf[["LUOKKA", "geometry"]] if "LUOKKA" in gdf.columns else gdf[["geometry"]])
        if not frames:
            return gpd.GeoDataFrame({"LUOKKA": [], "geometry": []}, geometry="geometry", crs=TM35FIN)
        merged = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=frames[0].crs)
        return merged.set_crs(TM35FIN, allow_override=True) if merged.crs is None else merged.to_crs(TM35FIN)


@dataclass(frozen=True)
class Municipality:
    code: str
    name: str
    name_swe: str
    land_area_km2: float
    geometry: BaseGeometry

    @property
    def slug(self) -> str:
        return slugify(self.name)

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        return tuple(float(v) for v in self.geometry.bounds)  # type: ignore[return-value]

    def tiles(self, level: int = DISTRIBUTION_LEVEL) -> list[str]:
        return tiles_covering(self.bounds, level=level)


# --------------------------------------------------------------------------
# Grid sources — what gridgen actually consumes
# --------------------------------------------------------------------------
def _points_from(gdf: gpd.GeoDataFrame) -> gpd.GeoSeries:
    """Reduce any geometry (footprint, outline, point) to a single point each."""
    if gdf.empty:
        return gpd.GeoSeries([], crs=TM35FIN)
    geoms = gdf.geometry
    needs_reduction = geoms.geom_type != "Point"
    if not needs_reduction.any():
        return geoms
    reduced = geoms.copy()
    reduced.loc[needs_reduction] = geoms.loc[needs_reduction].representative_point()
    return reduced


class MirrorSource:
    """Municipality-scoped view over downloaded Maastotietokanta sheets."""

    def __init__(
        self,
        municipality: Municipality,
        mirror: MmlMirror,
        tiles: Sequence[str] | None = None,
    ) -> None:
        self.municipality = municipality
        self.mirror = mirror
        self.tiles = list(tiles) if tiles is not None else municipality.tiles()
        self._boundary: BaseGeometry | None = None

    @property
    def label(self) -> str:
        return (
            f"MML Maastotietokanta {self.mirror.mtk_year} "
            f"({len(self.tiles)} sheets) + Kuntajako {self.mirror.kuntajako_year}, EPSG:3067"
        )

    def boundary(self) -> BaseGeometry:
        if self._boundary is None:
            self._boundary = self.municipality.geometry
        return self._boundary

    def _layer(self, name: str) -> gpd.GeoDataFrame:
        return self.mirror.read_layer(name, self.tiles, bbox=self.municipality.bounds)

    def buildings(self) -> gpd.GeoDataFrame:
        frames = []
        for key in ("buildings", "building_points"):
            gdf = self._layer(key)
            if not gdf.empty:
                frames.append(gpd.GeoDataFrame(geometry=_points_from(gdf), crs=TM35FIN))
        if not frames:
            return gpd.GeoDataFrame({"geometry": []}, geometry="geometry", crs=TM35FIN)
        merged = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=TM35FIN)
        return merged[merged.within(self.boundary())].reset_index(drop=True)

    def roads(self) -> gpd.GeoDataFrame:
        gdf = self._layer("roads")
        return gdf.reset_index(drop=True)

    def power_points(self) -> gpd.GeoDataFrame:
        gdf = self._layer("power_points")
        if gdf.empty:
            return gdf
        points = gpd.GeoDataFrame(geometry=_points_from(gdf), crs=TM35FIN)
        return points[points.within(self.boundary())].reset_index(drop=True)


class LegacyDirSource:
    """The original source: one pre-downloaded, descriptively named map sheet.

    Kept working for existing `mml-data/<SHEET>/` downloads. Note the boundary is
    whatever the sheet contains, so municipalities crossing a sheet edge are
    silently clipped — the reason `MirrorSource` exists.
    """

    def __init__(self, directory: Path, kunta_code: str, kunta_name: str) -> None:
        self.directory = Path(directory)
        self.kunta_code = str(kunta_code)
        self.kunta_name = kunta_name
        self.prefix = self.directory.name
        self._boundary: BaseGeometry | None = None

    @property
    def label(self) -> str:
        return f"MML Maastotietokanta ({self.prefix}), EPSG:3067"

    def _read(self, layer_key: str, **kwargs) -> gpd.GeoDataFrame:
        stem = LEGACY_LAYER_FILES[layer_key]
        if stem is None:
            return gpd.GeoDataFrame({"geometry": []}, geometry="geometry", crs=TM35FIN)
        path = self.directory / f"{self.prefix}_{stem}.shp"
        if not path.exists():
            raise FileNotFoundError(f"expected MML layer not found: {path}")
        return gpd.read_file(path, **kwargs)

    def boundary(self) -> BaseGeometry:
        if self._boundary is None:
            areas = self._read("boundaries")
            match = areas[areas.get("Kunta_ni1", pd.Series(dtype=str)) == self.kunta_name]
            if match.empty:
                match = areas[areas.get("Kunta", pd.Series(dtype=str)).astype(str) == self.kunta_code]
            if match.empty:
                raise LookupError(
                    f"{self.kunta_name} (code {self.kunta_code}) not present in {self.directory}"
                )
            self._boundary = unary_union(list(match.geometry))
        return self._boundary

    def buildings(self) -> gpd.GeoDataFrame:
        boundary = self.boundary()
        gdf = self._read("building_points", bbox=boundary.bounds)
        gdf = gpd.GeoDataFrame(geometry=_points_from(gdf), crs=gdf.crs or TM35FIN)
        return gdf[gdf.within(boundary)].reset_index(drop=True)

    def roads(self) -> gpd.GeoDataFrame:
        return self._read("roads", bbox=self.boundary().bounds).reset_index(drop=True)

    def power_points(self) -> gpd.GeoDataFrame:
        boundary = self.boundary()
        gdf = self._read("power_points")
        gdf = gpd.GeoDataFrame(geometry=_points_from(gdf), crs=gdf.crs or TM35FIN)
        return gdf[gdf.within(boundary)].reset_index(drop=True)


def describe_tiles(tiles: Sequence[str], year: str = DEFAULT_MTK_YEAR) -> str:
    lines = [f"{len(tiles)} map sheet(s), {SHEET_LEVELS[DISTRIBUTION_LEVEL]}, MTK {year}:"]
    for tile in tiles:
        e0, n0, e1, n1 = tile_bounds(tile)
        lines.append(f"  {tile}  E {e0:.0f}-{e1:.0f}  N {n0:.0f}-{n1:.0f}  {tile_url(tile, year)}")
    return "\n".join(lines)
