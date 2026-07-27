"""Offline tests for the MML map-sheet grid and download URL scheme.

The sheet extents asserted here were verified against the real extents of MML
Maastotietokanta shapefile deliveries, so a regression in `tile_bounds` (which
decides *which* sheets get downloaded) fails loudly. No network access.
"""

from __future__ import annotations

import pytest

from tools.gridgen import mmlsource


# Expected extents confirmed against the data inside the published sheets.
KNOWN_SHEETS = {
    "M4": (308_000, 6_762_000, 500_000, 6_858_000),
    "M44": (404_000, 6_810_000, 500_000, 6_858_000),
    "M43": (404_000, 6_762_000, 500_000, 6_810_000),
    "M441": (404_000, 6_810_000, 452_000, 6_834_000),
    "M4411R": (416_000, 6_810_000, 428_000, 6_822_000),
    "M4412R": (416_000, 6_822_000, 428_000, 6_834_000),
    "M4413L": (428_000, 6_810_000, 440_000, 6_822_000),
    "M4413R": (440_000, 6_810_000, 452_000, 6_822_000),
    "M4414L": (428_000, 6_822_000, 440_000, 6_834_000),
    "M4421R": (416_000, 6_834_000, 428_000, 6_846_000),
    "M4423L": (428_000, 6_834_000, 440_000, 6_846_000),
    "M4423R": (440_000, 6_834_000, 452_000, 6_846_000),
    "M4322R": (416_000, 6_798_000, 428_000, 6_810_000),
    "M4324L": (428_000, 6_798_000, 440_000, 6_810_000),
    "M4324R": (440_000, 6_798_000, 452_000, 6_810_000),
}


@pytest.mark.parametrize("tile,expected", sorted(KNOWN_SHEETS.items()))
def test_tile_bounds_match_published_sheets(tile, expected):
    assert mmlsource.tile_bounds(tile) == pytest.approx(expected)


def test_sheet_sizes_halve_at_every_level():
    sizes = {}
    for tile in ("M4", "M44", "M441", "M4411", "M4411R"):
        e0, n0, e1, n1 = mmlsource.tile_bounds(tile)
        sizes[tile] = (e1 - e0, n1 - n0)
    assert sizes["M4"] == (192_000, 96_000)
    assert sizes["M44"] == (96_000, 48_000)
    assert sizes["M441"] == (48_000, 24_000)
    assert sizes["M4411"] == (24_000, 12_000)
    assert sizes["M4411R"] == (12_000, 12_000)


def test_children_tile_the_parent_exactly():
    parent = mmlsource.tile_bounds("M441")
    children = [mmlsource.tile_bounds(f"M441{d}") for d in "1234"]
    assert min(c[0] for c in children) == parent[0]
    assert min(c[1] for c in children) == parent[1]
    assert max(c[2] for c in children) == parent[2]
    assert max(c[3] for c in children) == parent[3]
    area = sum((c[2] - c[0]) * (c[3] - c[1]) for c in children)
    assert area == (parent[2] - parent[0]) * (parent[3] - parent[1])


@pytest.mark.parametrize("bad", ["", "A4", "M9", "M44Z", "44M"])
def test_invalid_sheet_names_are_rejected(bad):
    with pytest.raises(ValueError):
        mmlsource.tile_bounds(bad)


def test_tiles_covering_returns_every_sheet_over_the_bbox():
    # Sysmä's true extent from the national municipality division. It crosses the
    # M43/M44 sheet boundary — the case the single-sheet generator used to clip.
    bounds = (416_789.25, 6_797_962.43, 456_643.89, 6_843_507.21)
    tiles = mmlsource.tiles_covering(bounds)

    assert tiles, "expected at least one covering sheet"
    assert len(set(tiles)) == len(tiles)
    assert all(len(t) == mmlsource.DISTRIBUTION_LEVEL for t in tiles)
    # Sheets from both level-2 sheets must be present.
    assert any(t.startswith("M43") for t in tiles)
    assert any(t.startswith("M44") for t in tiles)
    # Every returned sheet genuinely overlaps, and nothing is missed: the union
    # of the returned sheets must cover the whole bbox.
    for tile in tiles:
        e0, n0, e1, n1 = mmlsource.tile_bounds(tile)
        assert e0 < bounds[2] and e1 > bounds[0]
        assert n0 < bounds[3] and n1 > bounds[1]
    covered = [mmlsource.tile_bounds(t) for t in tiles]
    assert min(c[0] for c in covered) <= bounds[0]
    assert min(c[1] for c in covered) <= bounds[1]
    assert max(c[2] for c in covered) >= bounds[2]
    assert max(c[3] for c in covered) >= bounds[3]


def test_tiles_covering_excludes_sheets_that_only_touch_the_edge():
    # A bbox exactly filling M4411R must not pull in its neighbours.
    bounds = mmlsource.tile_bounds("M4411R")
    assert mmlsource.tiles_covering(bounds) == ["M4411R"]


def test_tile_url_matches_the_published_layout():
    assert mmlsource.tile_url("M4411R", "2025") == (
        "https://www.nic.funet.fi/index/geodata/mml/maastotietokanta/2025/shp/"
        "M4/M44/M4411R.shp.zip"
    )


def test_tile_url_rejects_sheets_that_are_not_published():
    with pytest.raises(ValueError):
        mmlsource.tile_url("M44")


@pytest.mark.parametrize(
    "name,slug",
    [("Sysmä", "sysma"), ("Pargas", "pargas"), ("Pyhtää", "pyhtaa"), ("Ii", "ii")],
)
def test_slugify_folds_finnish_diacritics(name, slug):
    assert mmlsource.slugify(name) == slug


def test_layer_catalogue_filters_by_feature_class():
    import pandas as pd

    roads = mmlsource.LAYERS["roads"]
    # 12141 = a road; 12313 = a railway; both live in the transport theme.
    keep = roads.matches(pd.Series([12141, 12131, 12313, 16511]))
    assert list(keep) == [True, True, False, False]

    buildings = mmlsource.LAYERS["buildings"]
    # Residential / holiday / commercial / other get a käyttöpaikka; outbuildings
    # (4226x) and non-building structures (44300) must not.
    classes = pd.Series([42211, 42231, 42221, 42241, 42270, 42261, 42260, 44300])
    assert list(buildings.matches(classes)) == [True] * 5 + [False] * 3


def test_electrical_stations_are_read_from_the_line_file():
    # MML maps class 22200 (Sähköasema) as a short outline, not a point, so the
    # substation seed layer must come from the utility *line* file.
    spec = mmlsource.LAYERS["power_points"]
    assert (spec.theme, spec.kind) == ("j", "v")
    assert spec.ranges == ((22200, 22200),)
    # Power lines must not swallow the stations.
    assert not mmlsource.LAYERS["power_lines"].matches(__import__("pandas").Series([22200])).iloc[0]
