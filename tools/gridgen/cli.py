"""gridgen CLI — download MML map sheets and generate a synthetic distribution
grid for any Finnish municipality.

    python -m tools.gridgen municipalities --search sys
    python -m tools.gridgen tiles --municipality Sysmä
    python -m tools.gridgen download --municipality Sysmä
    python -m tools.gridgen config --municipality Kuhmoinen
    python -m tools.gridgen build --municipality Sysmä --out tools/gridgen/output
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.gridgen import gridgen, mmlsource  # noqa: E402

OUTPUT_FILES = (
    "substations.geojson",
    "transformers.geojson",
    "kayttopaikat.geojson",
    "feeders.geojson",
    "topology.json",
)


def _mirror(args: argparse.Namespace) -> mmlsource.MmlMirror:
    return mmlsource.MmlMirror(
        cache_dir=Path(args.cache_dir),
        mtk_year=args.mtk_year,
        kuntajako_year=args.kuntajako_year,
        quiet=getattr(args, "quiet", False),
    )


def _resolve(args: argparse.Namespace) -> tuple[mmlsource.MmlMirror, mmlsource.Municipality]:
    mirror = _mirror(args)
    return mirror, mirror.find_municipality(args.municipality)


def _config_for(args: argparse.Namespace) -> dict:
    """Load the municipality config, or synthesize one on the fly."""
    if args.config:
        return json.loads(Path(args.config).read_text(encoding="utf-8"))

    _, muni = _resolve(args)
    path = gridgen.config_path(muni.slug)
    if path.exists():
        cfg = json.loads(path.read_text(encoding="utf-8"))
        print(f"[gridgen] using config {path.relative_to(REPO_ROOT)}")
    else:
        cfg = gridgen.default_config(muni)
        print(f"[gridgen] no config at {path.relative_to(REPO_ROOT)} — using defaults")
    cfg.setdefault("gridgen", {})
    if args.source:
        cfg["gridgen"]["source"] = args.source
    cfg["gridgen"].setdefault("mtkYear", args.mtk_year)
    cfg["gridgen"].setdefault("kuntajakoYear", args.kuntajako_year)
    for key, value in (
        ("feederCount", args.feeders),
        ("substationCount", args.substations),
    ):
        if value is not None:
            cfg["gridgen"][key] = value
    if args.substations is not None:
        # Drop hand-written seeds that no longer match the requested count.
        seeds = cfg["gridgen"].get("substations") or []
        if len(seeds) != args.substations:
            cfg["gridgen"]["substations"] = seeds[: args.substations]
    return cfg


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------
def cmd_municipalities(args: argparse.Namespace) -> int:
    table = _mirror(args).municipalities()
    if args.search:
        needle = args.search.casefold()
        table = table[
            table["name"].str.casefold().str.contains(needle)
            | table["name_swe"].str.casefold().str.contains(needle)
            | table["code"].str.contains(needle)
        ]
    if table.empty:
        print(f"no municipality matches {args.search!r}")
        return 1
    print(f"{'code':>5}  {'name':<24} {'swedish':<24} {'land km²':>9}")
    for row in table.itertuples():
        print(f"{row.code:>5}  {row.name:<24} {row.name_swe:<24} {row.land_area_km2:>9.0f}")
    print(f"\n{len(table)} municipalities")
    return 0


def cmd_tiles(args: argparse.Namespace) -> int:
    _, muni = _resolve(args)
    tiles = muni.tiles()
    e0, n0, e1, n1 = muni.bounds
    print(f"{muni.name} ({muni.name_swe}), kunta {muni.code}, {muni.land_area_km2:.0f} km² land")
    print(f"  bbox TM35FIN: E {e0:.0f}-{e1:.0f}  N {n0:.0f}-{n1:.0f}")
    print(mmlsource.describe_tiles(tiles, args.mtk_year))
    return 0


def cmd_download(args: argparse.Namespace) -> int:
    mirror, muni = _resolve(args)
    tiles = muni.tiles()
    print(f"[gridgen] {muni.name}: {len(tiles)} map sheet(s) to fetch into {mirror.cache_dir}")
    available = mirror.fetch_tiles(tiles, refresh=args.refresh)
    print(f"[gridgen] ready: {len(available)} sheet(s) cached")
    return 0


def cmd_config(args: argparse.Namespace) -> int:
    _, muni = _resolve(args)
    overrides = {}
    if args.feeders is not None:
        overrides["feederCount"] = args.feeders
    if args.substations is not None:
        overrides["substationCount"] = args.substations
    cfg = gridgen.default_config(muni, overrides)
    path = Path(args.out) if args.out else gridgen.config_path(muni.slug)
    if path.exists() and not args.force:
        print(f"refusing to overwrite {path} (pass --force)")
        return 1
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[gridgen] wrote {path}")
    print("  Review compensation tiers, feeder count and substation names before building.")
    return 0


def cmd_build(args: argparse.Namespace) -> int:
    cfg = _config_for(args)
    out = Path(args.out) if args.out else gridgen.DEFAULT_OUTPUT_DIR
    existing = [f for f in OUTPUT_FILES if (out / f).exists()]
    if existing and not args.force:
        print(
            f"refusing to overwrite {len(existing)} existing file(s) in {out}.\n"
            "  Regenerating invalidates the seg_ids referenced by scenarios/*.json.\n"
            "  Pass --force to overwrite, or --out <dir> to write elsewhere."
        )
        return 1
    summary = gridgen.build(
        cfg,
        output_dir=out,
        cache_dir=Path(args.cache_dir),
        refresh=args.refresh,
        quiet=args.quiet,
    )
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


# --------------------------------------------------------------------------
# Parser
# --------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m tools.gridgen",
        description=(
            "Download MML open data and generate a synthetic MV distribution grid "
            "for any Finnish municipality."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--cache-dir",
        default=str(mmlsource.DEFAULT_CACHE_DIR),
        help="where downloaded MML data is cached (default: %(default)s)",
    )
    parser.add_argument(
        "--mtk-year",
        default=mmlsource.DEFAULT_MTK_YEAR,
        help="Maastotietokanta vintage (default: %(default)s)",
    )
    parser.add_argument(
        "--kuntajako-year",
        default=mmlsource.DEFAULT_KUNTAJAKO_YEAR,
        help="municipality division vintage (default: %(default)s)",
    )
    parser.add_argument("--quiet", action="store_true", help="suppress download chatter")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_municipality(p: argparse.ArgumentParser) -> None:
        p.add_argument(
            "-m",
            "--municipality",
            required=True,
            help="Finnish or Swedish name, or kunta code (e.g. Sysmä, Pargas, 781)",
        )

    p = sub.add_parser("municipalities", help="list/search Finnish municipalities")
    p.add_argument("--search", help="filter by name or code")
    p.set_defaults(func=cmd_municipalities)

    p = sub.add_parser("tiles", help="show which MML map sheets cover a municipality")
    add_municipality(p)
    p.set_defaults(func=cmd_tiles)

    p = sub.add_parser("download", help="download the map sheets covering a municipality")
    add_municipality(p)
    p.add_argument("--refresh", action="store_true", help="re-download cached sheets")
    p.set_defaults(func=cmd_download)

    p = sub.add_parser("config", help="write a starter config/municipality.<id>.json")
    add_municipality(p)
    p.add_argument("--out", help="config path (default: config/municipality.<slug>.json)")
    p.add_argument("--feeders", type=int, help="number of MV feeders to generate")
    p.add_argument("--substations", type=int, help="number of primary substations")
    p.add_argument("--force", action="store_true", help="overwrite an existing config")
    p.set_defaults(func=cmd_config)

    p = sub.add_parser("build", help="download (if needed) and generate the grid")
    add_municipality(p)
    p.add_argument("--config", help="use this config file instead of config/municipality.*.json")
    p.add_argument("--out", help="output directory (default: tools/gridgen/output)")
    p.add_argument("--source", choices=("mirror", "local"), help="override the data source")
    p.add_argument("--feeders", type=int, help="number of MV feeders to generate")
    p.add_argument("--substations", type=int, help="number of primary substations")
    p.add_argument("--refresh", action="store_true", help="re-download cached sheets")
    p.add_argument("--force", action="store_true", help="overwrite existing output")
    p.add_argument("--json", action="store_true", help="print a JSON summary")
    p.set_defaults(func=cmd_build)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (LookupError, FileNotFoundError, ValueError, mmlsource.DownloadError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
