"""Verkkovahti storm scenario simulation engine.

Drives the compressed-timeline storm: fires faults, applies dispatch
assignments (from the frontend or the CLI), moves crews along a great-circle
path, restores power after the repair effort elapses, and writes all state to
the Fabric SQL Database so the frontend can poll it via GraphQL.

The scenario clock and player controls live in the single `ScenarioStates` row,
so the frontend player and the simulator share one control channel.
"""

from __future__ import annotations

import json
import math
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Optional

from .db import Db

REPO_ROOT = Path(__file__).resolve().parents[1]
TOPOLOGY = REPO_ROOT / "tools" / "gridgen" / "output" / "topology.json"
SCENARIO_DIR = REPO_ROOT / "scenarios"

CREW_SPEED_KMH = 60.0
ROAD_FACTOR = 1.3  # great-circle × factor ≈ road distance (no routing engine)
ARRIVE_KM = 0.10
LIVE_TABLES = ["Incidents", "Assignments", "GridEvents"]

# status/action string literals (mirror the entity doc comments)
ST_OPEN, ST_ASSIGNED, ST_ENROUTE, ST_ONSITE, ST_RESTORED = (
    "open",
    "assigned",
    "enroute",
    "onsite",
    "restored",
)
CREW_IDLE, CREW_ENROUTE, CREW_ONSITE, CREW_RETURNING, CREW_OFFSHIFT = (
    "idle",
    "enroute",
    "onsite",
    "returning",
    "offshift",
)


def haversine_km(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    r = 6371.0
    p = math.pi / 180
    dlat = (b_lat - a_lat) * p
    dlon = (b_lon - a_lon) * p
    x = (
        math.sin(dlat / 2) ** 2
        + math.cos(a_lat * p) * math.cos(b_lat * p) * math.sin(dlon / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(x))


def eta_minutes(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> int:
    km = haversine_km(a_lat, a_lon, b_lat, b_lon) * ROAD_FACTOR
    return max(1, round(km / CREW_SPEED_KMH * 60))


@dataclass
class IncidentMeta:
    incident_id: str
    seg_id: str
    feeder_id: str
    ss_id: str
    fault_type: str
    lat: float
    lon: float
    offset_min: int
    repair_effort_min: int
    required_skill: str


@dataclass
class EngineState:
    fired: set = field(default_factory=set)  # incident_ids created
    applied_assignments: set = field(default_factory=set)  # Assignment ids
    onsite_at: Dict[str, datetime] = field(default_factory=dict)  # crew_id -> sim


class Engine:
    def __init__(self, scenario_id: str = "mauri-2026", auto: bool = False):
        self.scenario = json.loads(
            (SCENARIO_DIR / f"{scenario_id}.json").read_text(encoding="utf-8")
        )
        self.topo = json.loads(TOPOLOGY.read_text(encoding="utf-8"))
        self.auto = auto
        self.start = datetime.fromisoformat(
            self.scenario["startWallClock"]
        ).replace(tzinfo=None)
        self.state = EngineState()
        self.snapshot: dict = {}
        self.incident_meta: Dict[str, IncidentMeta] = {}
        for f in self.scenario["faults"]:
            self.incident_meta[f["incident_id"]] = IncidentMeta(
                incident_id=f["incident_id"],
                seg_id=f["seg_id"],
                feeder_id=f["feeder_id"],
                ss_id=f["ss_id"],
                fault_type=f["fault_type"],
                lat=f["lat"],
                lon=f["lon"],
                offset_min=f["offsetMin"],
                repair_effort_min=f["repair_effort_min"],
                required_skill=f.get("requiredSkill", "line"),
            )

    # -- topology helpers ------------------------------------------------
    def seg_affected(self, seg_id: str) -> tuple[int, int, list[str]]:
        seg = self.topo["segments"].get(seg_id, {})
        kps = seg.get("kayttopaikka_ids", [])
        return len(kps), len(seg.get("transformer_ids", [])), kps

    # -- seeding / reset -------------------------------------------------
    def seed(self, db: Db) -> None:
        """(Re)create crews + the scenario-state row at the storm start."""
        db.delete_all(LIVE_TABLES + ["Crews", "ScenarioStates"])
        now = self.start
        for c in self.scenario["crews"]:
            db.insert(
                "Crews",
                {
                    "id": str(uuid.uuid4()),
                    "crew_id": c["crew_id"],
                    "callsign": c["callsign"],
                    "skills": ",".join(c["skills"]),
                    "depot_lat": f"{c['depot']['lat']:.6f}",
                    "depot_lon": f"{c['depot']['lon']:.6f}",
                    "lat": f"{c['depot']['lat']:.6f}",
                    "lon": f"{c['depot']['lon']:.6f}",
                    "status": CREW_IDLE,
                    "shift_start": datetime.fromisoformat(c["shift_start"]).replace(tzinfo=None),
                    "shift_end": datetime.fromisoformat(c["shift_end"]).replace(tzinfo=None),
                    "current_incident_id": None,
                    "updated_at": now,
                },
            )
        db.insert(
            "ScenarioStates",
            {
                "id": str(uuid.uuid4()),
                "scenario_id": self.scenario["id"],
                "sim_clock": now,
                "playing": 0,
                "speed": self.scenario.get("defaultSpeed", 24),
                "status": "idle",
                "updated_at": now,
            },
        )
        self.state = EngineState()

    def reset(self, db: Db) -> None:
        """Clear incidents/events/assignments and return crews to depots."""
        db.delete_all(LIVE_TABLES)
        now = self.start
        for c in self.scenario["crews"]:
            db.update(
                "Crews",
                {"crew_id": c["crew_id"]},
                {
                    "lat": f"{c['depot']['lat']:.6f}",
                    "lon": f"{c['depot']['lon']:.6f}",
                    "status": CREW_IDLE,
                    "current_incident_id": None,
                    "updated_at": now,
                },
            )
        db.update(
            "ScenarioStates",
            {"scenario_id": self.scenario["id"]},
            {"sim_clock": now, "playing": 0, "status": "idle", "updated_at": now},
        )
        self.state = EngineState()

    # -- event log -------------------------------------------------------
    def _event(self, db: Db, ts, etype, entity_id, feeder_id=None, payload=None):
        db.insert(
            "GridEvents",
            {
                "id": str(uuid.uuid4()),
                "ts": ts,
                "event_type": etype,
                "entity_id": entity_id,
                "feeder_id": feeder_id,
                "payload": json.dumps(payload) if payload else None,
            },
        )

    # -- one tick --------------------------------------------------------
    def tick(self, db: Db, dt_real: float) -> dict:
        state = db.query(
            "SELECT TOP 1 * FROM ScenarioStates WHERE scenario_id = ?",
            [self.scenario["id"]],
        )
        if not state:
            self.seed(db)
            return {"note": "seeded"}
        s = state[0]
        sim_clock: datetime = s["sim_clock"]
        playing = bool(s["playing"])
        speed = float(s["speed"])

        if not playing or s["status"] == "done":
            self._refresh_snapshot(db)
            return {"sim_clock": sim_clock, "playing": playing, "idle": True}

        # advance the compressed clock
        sim_clock = sim_clock + timedelta(seconds=dt_real * speed)
        elapsed_min = (sim_clock - self.start).total_seconds() / 60.0
        end_min = self.scenario["simDurationMin"]

        crews = {c["crew_id"]: c for c in db.query("SELECT * FROM Crews")}
        incidents = {
            i["incident_id"]: i for i in db.query("SELECT * FROM Incidents")
        }

        self._fire_faults(db, sim_clock, elapsed_min, incidents)
        self._apply_assignments(db, sim_clock, crews, incidents)
        if self.auto:
            self._auto_dispatch(db, sim_clock, crews, incidents)
        self._move_crews(db, sim_clock, dt_real * speed, crews, incidents)

        status = "running"
        if elapsed_min >= end_min and all(
            i["status"] == ST_RESTORED for i in incidents.values()
        ) and len(incidents) == len(self.scenario["faults"]):
            status = "done"

        db.update(
            "ScenarioStates",
            {"scenario_id": self.scenario["id"]},
            {"sim_clock": sim_clock, "status": status, "updated_at": sim_clock},
        )
        self._refresh_snapshot(db)
        return {
            "sim_clock": sim_clock,
            "elapsed_min": round(elapsed_min, 1),
            "customers_out": self.customers_out(incidents),
            "active": sum(1 for i in incidents.values() if i["status"] != ST_RESTORED),
            "status": status,
        }

    # -- snapshot for the local dev HTTP server --------------------------
    def wind_at(self, elapsed_min: float) -> dict:
        pts = self.scenario["storm"]["wind"]
        prev = pts[0]
        for p in pts:
            if p["offsetMin"] <= elapsed_min:
                prev = p
            else:
                nxt = p
                span = nxt["offsetMin"] - prev["offsetMin"] or 1
                f = (elapsed_min - prev["offsetMin"]) / span
                return {
                    "speed_ms": round(prev["speed_ms"] + (nxt["speed_ms"] - prev["speed_ms"]) * f, 1),
                    "gust_ms": round(prev["gust_ms"] + (nxt["gust_ms"] - prev["gust_ms"]) * f, 1),
                    "dir_deg": round(prev["dir_deg"] + (nxt["dir_deg"] - prev["dir_deg"]) * f),
                }
        return {"speed_ms": prev["speed_ms"], "gust_ms": prev["gust_ms"], "dir_deg": prev["dir_deg"]}

    def _iso(self, v):
        return v.isoformat() if isinstance(v, datetime) else v

    def _refresh_snapshot(self, db: Db) -> None:
        srows = db.query(
            "SELECT TOP 1 * FROM ScenarioStates WHERE scenario_id = ?",
            [self.scenario["id"]],
        )
        if not srows:
            self.snapshot = {}
            return
        s = srows[0]
        sim_clock = s["sim_clock"]
        elapsed_min = (sim_clock - self.start).total_seconds() / 60.0
        crews = db.query("SELECT * FROM Crews")
        incidents = db.query("SELECT * FROM Incidents")
        for c in crews:
            c["shift_start"] = self._iso(c.get("shift_start"))
            c["shift_end"] = self._iso(c.get("shift_end"))
            c["updated_at"] = self._iso(c.get("updated_at"))
            c["id"] = str(c["id"])
        for i in incidents:
            i["started_at"] = self._iso(i.get("started_at"))
            i["restored_at"] = self._iso(i.get("restored_at"))
            i["updated_at"] = self._iso(i.get("updated_at"))
            i["id"] = str(i["id"])
        self.snapshot = {
            "scenario": {
                "scenario_id": s["scenario_id"],
                "status": s["status"],
                "playing": bool(s["playing"]),
                "speed": float(s["speed"]),
                "sim_clock": self._iso(sim_clock),
                "elapsed_min": round(elapsed_min, 1),
                "start": self._iso(self.start),
            },
            "wind": self.wind_at(elapsed_min),
            "crews": crews,
            "incidents": incidents,
        }

    def _fire_faults(self, db, sim_clock, elapsed_min, incidents) -> None:
        for m in self.incident_meta.values():
            if m.incident_id in incidents or m.incident_id in self.state.fired:
                continue
            if elapsed_min < m.offset_min:
                continue
            kp, tr, _ = self.seg_affected(m.seg_id)
            db.insert(
                "Incidents",
                {
                    "id": str(uuid.uuid4()),
                    "incident_id": m.incident_id,
                    "seg_id": m.seg_id,
                    "feeder_id": m.feeder_id,
                    "ss_id": m.ss_id,
                    "fault_type": m.fault_type,
                    "affected_kp": kp,
                    "affected_tr": tr,
                    "repair_effort_min": m.repair_effort_min,
                    "status": ST_OPEN,
                    "crew_id": None,
                    "eta_min": None,
                    "started_at": sim_clock,
                    "restored_at": None,
                    "updated_at": sim_clock,
                },
            )
            self._event(
                db, sim_clock, "fault", m.seg_id, m.feeder_id,
                {"incident_id": m.incident_id, "type": m.fault_type, "kp": kp},
            )
            self.state.fired.add(m.incident_id)
            incidents[m.incident_id] = {
                "incident_id": m.incident_id, "status": ST_OPEN,
                "crew_id": None, "seg_id": m.seg_id,
            }

    def _assign(self, db, sim_clock, crew, incident_id) -> None:
        m = self.incident_meta[incident_id]
        eta = eta_minutes(float(crew["lat"]), float(crew["lon"]), m.lat, m.lon)
        db.update(
            "Incidents", {"incident_id": incident_id},
            {"crew_id": crew["crew_id"], "status": ST_ASSIGNED, "eta_min": eta,
             "updated_at": sim_clock},
        )
        db.update(
            "Crews", {"crew_id": crew["crew_id"]},
            {"current_incident_id": incident_id, "status": CREW_ENROUTE,
             "updated_at": sim_clock},
        )
        crew["current_incident_id"] = incident_id
        crew["status"] = CREW_ENROUTE
        self._event(db, sim_clock, "crew_status", crew["crew_id"], m.feeder_id,
                    {"assigned": incident_id, "eta_min": eta})

    def _apply_assignments(self, db, sim_clock, crews, incidents) -> None:
        rows = db.query("SELECT * FROM Assignments ORDER BY ts")
        for a in rows:
            if a["id"] in self.state.applied_assignments:
                continue
            self.state.applied_assignments.add(a["id"])
            crew = crews.get(a["crew_id"])
            inc = incidents.get(a["incident_id"])
            if not crew or not inc:
                continue
            if a["action"] == "cancel":
                if crew.get("current_incident_id") == a["incident_id"]:
                    self._return_crew(db, sim_clock, crew)
                continue
            if inc["status"] in (ST_RESTORED,) or crew["status"] not in (CREW_IDLE,):
                continue
            self._assign(db, sim_clock, crew, a["incident_id"])

    def _auto_dispatch(self, db, sim_clock, crews, incidents) -> None:
        open_incs = [
            i for i in incidents.values()
            if i["status"] == ST_OPEN and not i.get("crew_id")
        ]
        for inc in open_incs:
            m = self.incident_meta[inc["incident_id"]]
            best = None
            best_km = 1e9
            for crew in crews.values():
                if crew["status"] != CREW_IDLE:
                    continue
                skills = crew["skills"].split(",")
                if m.required_skill not in skills:
                    continue
                km = haversine_km(float(crew["lat"]), float(crew["lon"]), m.lat, m.lon)
                if km < best_km:
                    best, best_km = crew, km
            if best is not None:
                # go through the Assignments table so it's the same code path
                db.insert("Assignments", {
                    "id": str(uuid.uuid4()),
                    "incident_id": inc["incident_id"],
                    "crew_id": best["crew_id"],
                    "action": "dispatch",
                    "eta_min": eta_minutes(float(best["lat"]), float(best["lon"]), m.lat, m.lon),
                    "ts": sim_clock,
                })
                self._assign(db, sim_clock, best, inc["incident_id"])
                self.state.applied_assignments.add("auto-" + inc["incident_id"])

    def _return_crew(self, db, sim_clock, crew) -> None:
        db.update("Crews", {"crew_id": crew["crew_id"]},
                  {"status": CREW_IDLE, "current_incident_id": None,
                   "updated_at": sim_clock})
        crew["status"] = CREW_IDLE
        crew["current_incident_id"] = None

    def _move_crews(self, db, sim_clock, dt_sim_s, crews, incidents) -> None:
        step_km = CREW_SPEED_KMH * (dt_sim_s / 3600.0)
        for crew in crews.values():
            inc_id = crew.get("current_incident_id")
            if not inc_id or crew["status"] not in (CREW_ENROUTE, CREW_ONSITE):
                continue
            m = self.incident_meta[inc_id]
            clat, clon = float(crew["lat"]), float(crew["lon"])
            dist = haversine_km(clat, clon, m.lat, m.lon)

            if crew["status"] == CREW_ENROUTE:
                if dist <= max(ARRIVE_KM, step_km):
                    db.update("Crews", {"crew_id": crew["crew_id"]},
                              {"lat": f"{m.lat:.6f}", "lon": f"{m.lon:.6f}",
                               "status": CREW_ONSITE, "updated_at": sim_clock})
                    db.update("Incidents", {"incident_id": inc_id},
                              {"status": ST_ONSITE, "updated_at": sim_clock})
                    self.state.onsite_at[crew["crew_id"]] = sim_clock
                    self._event(db, sim_clock, "crew_status", crew["crew_id"],
                                m.feeder_id, {"onsite": inc_id})
                else:
                    frac = step_km / dist
                    nlat = clat + (m.lat - clat) * frac
                    nlon = clon + (m.lon - clon) * frac
                    db.update("Crews", {"crew_id": crew["crew_id"]},
                              {"lat": f"{nlat:.6f}", "lon": f"{nlon:.6f}",
                               "updated_at": sim_clock})
                continue

            # onsite -> repairing
            onsite = self.state.onsite_at.get(crew["crew_id"], sim_clock)
            if (sim_clock - onsite).total_seconds() / 60.0 >= m.repair_effort_min:
                db.update("Incidents", {"incident_id": inc_id},
                          {"status": ST_RESTORED, "restored_at": sim_clock,
                           "updated_at": sim_clock})
                self._event(db, sim_clock, "restoration", m.seg_id, m.feeder_id,
                            {"incident_id": inc_id})
                self._return_crew(db, sim_clock, crew)

    # -- KPI helpers -----------------------------------------------------
    def customers_out(self, incidents: dict) -> int:
        out: set[str] = set()
        for i in incidents.values():
            if i["status"] == ST_RESTORED:
                continue
            seg = self.topo["segments"].get(i["seg_id"], {})
            out.update(seg.get("kayttopaikka_ids", []))
        return len(out)
