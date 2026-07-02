"""TDS access to the Fabric-hosted Rayfin SQL Database.

The simulator writes directly to the backing Fabric SQL Database over TDS using
an Entra token (the sanctioned Rayfin GraphQL write path needs an interactive
Fabric-SSO session, impractical for a headless service). See RAYFIN-FEEDBACK.md.
"""

from __future__ import annotations

import json
import struct
import subprocess
from pathlib import Path
from typing import Any, Iterable, Sequence

import pyodbc

REPO_ROOT = Path(__file__).resolve().parents[1]
DB_CONFIG = REPO_ROOT / "config" / "db.local.json"

SQL_COPT_SS_ACCESS_TOKEN = 1256  # pyodbc access-token connection attribute
_DRIVER = "ODBC Driver 18 for SQL Server"


def _load_cfg() -> dict:
    if not DB_CONFIG.exists():
        raise FileNotFoundError(
            f"{DB_CONFIG} not found. Copy config/db.example.json to "
            "config/db.local.json and fill in the Fabric SQL DB values "
            "(GET /v1/workspaces/{ws}/SQLDatabases/{id})."
        )
    return json.loads(DB_CONFIG.read_text(encoding="utf-8"))


def _entra_token() -> bytes:
    out = subprocess.run(
        [
            "az",
            "account",
            "get-access-token",
            "--resource",
            "https://database.windows.net/",
            "--query",
            "accessToken",
            "-o",
            "tsv",
        ],
        capture_output=True,
        text=True,
        shell=True,
    )
    tok = out.stdout.strip()
    if len(tok) < 100:
        raise RuntimeError(
            "Could not obtain an Entra token via 'az account get-access-token'. "
            "Run 'az login' first. stderr: " + out.stderr.strip()
        )
    b = tok.encode("utf-16-le")
    return struct.pack("=i", len(b)) + b


def connect() -> pyodbc.Connection:
    cfg = _load_cfg()
    token = _entra_token()
    conn = pyodbc.connect(
        f"Driver={{{_DRIVER}}};Server={cfg['serverFqdn']};"
        f"Database={cfg['databaseName']};Encrypt=yes;TrustServerCertificate=no",
        attrs_before={SQL_COPT_SS_ACCESS_TOKEN: token},
        timeout=30,
        autocommit=True,
    )
    return conn


class Db:
    """Thin convenience wrapper around a pyodbc connection."""

    def __init__(self) -> None:
        self.conn = connect()

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:
            pass

    def exec(self, sql: str, params: Sequence[Any] = ()) -> None:
        cur = self.conn.cursor()
        cur.execute(sql, params)
        cur.close()

    def query(self, sql: str, params: Sequence[Any] = ()) -> list[dict]:
        cur = self.conn.cursor()
        cur.execute(sql, params)
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        cur.close()
        return rows

    def scalar(self, sql: str, params: Sequence[Any] = ()) -> Any:
        cur = self.conn.cursor()
        cur.execute(sql, params)
        row = cur.fetchone()
        cur.close()
        return row[0] if row else None

    # -- table helpers --------------------------------------------------
    def insert(self, table: str, row: dict) -> None:
        cols = ", ".join(f"[{c}]" for c in row)
        marks = ", ".join("?" for _ in row)
        self.exec(
            f"INSERT INTO [{table}] ({cols}) VALUES ({marks})",
            list(row.values()),
        )

    def update(self, table: str, key: dict, values: dict) -> None:
        set_clause = ", ".join(f"[{c}] = ?" for c in values)
        where = " AND ".join(f"[{c}] = ?" for c in key)
        self.exec(
            f"UPDATE [{table}] SET {set_clause} WHERE {where}",
            list(values.values()) + list(key.values()),
        )

    def delete_all(self, tables: Iterable[str]) -> None:
        for t in tables:
            self.exec(f"DELETE FROM [{t}]")
