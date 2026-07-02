"""Simulator CLI.

  python -m simulator seed                 # create crews + scenario-state row
  python -m simulator reset                # clear incidents/crews to start
  python -m simulator run [--auto] [--speed N] [--tick 1.0]
  python -m simulator play | pause
  python -m simulator set-speed N
  python -m simulator status
  python -m simulator dispatch INC-05 K-2  # write an Assignment (test dispatch)
"""

from __future__ import annotations

import argparse
import sys
import time
import uuid
from datetime import datetime

from .db import Db
from .engine import Engine


def _state(db: Db, scenario_id: str):
    rows = db.query(
        "SELECT TOP 1 * FROM ScenarioStates WHERE scenario_id = ?", [scenario_id]
    )
    return rows[0] if rows else None


def cmd_seed(args):
    eng = Engine(args.scenario)
    db = Db()
    eng.seed(db)
    db.close()
    print(f"Seeded {len(eng.scenario['crews'])} crews + scenario '{args.scenario}' at {eng.start}.")


def cmd_reset(args):
    eng = Engine(args.scenario)
    db = Db()
    if not _state(db, eng.scenario["id"]):
        eng.seed(db)
    else:
        eng.reset(db)
    db.close()
    print("Reset to storm start (idle).")


def _set_playing(args, playing: bool):
    eng = Engine(args.scenario)
    db = Db()
    now = datetime.now()
    db.update("ScenarioStates", {"scenario_id": eng.scenario["id"]},
              {"playing": 1 if playing else 0,
               "status": "running" if playing else "paused", "updated_at": now})
    db.close()
    print("Playing." if playing else "Paused.")


def cmd_play(args):
    _set_playing(args, True)


def cmd_pause(args):
    _set_playing(args, False)


def cmd_set_speed(args):
    eng = Engine(args.scenario)
    db = Db()
    db.update("ScenarioStates", {"scenario_id": eng.scenario["id"]},
              {"speed": args.value, "updated_at": datetime.now()})
    db.close()
    print(f"Speed set to {args.value}x.")


def cmd_dispatch(args):
    eng = Engine(args.scenario)
    db = Db()
    db.insert("Assignments", {
        "id": str(uuid.uuid4()),
        "incident_id": args.incident,
        "crew_id": args.crew,
        "action": args.action,
        "eta_min": 0,
        "ts": datetime.now(),
    })
    db.close()
    print(f"Assignment written: {args.action} {args.crew} -> {args.incident}.")


def cmd_status(args):
    eng = Engine(args.scenario)
    db = Db()
    s = _state(db, eng.scenario["id"])
    incidents = {i["incident_id"]: i for i in db.query("SELECT * FROM Incidents")}
    crews = db.query("SELECT crew_id, status, lat, lon, current_incident_id FROM Crews ORDER BY crew_id")
    if not s:
        print("No scenario state — run 'seed' first.")
        db.close()
        return
    print(f"scenario   : {s['scenario_id']}  status={s['status']}  playing={bool(s['playing'])}  speed={float(s['speed'])}x")
    print(f"sim_clock  : {s['sim_clock']}")
    print(f"customers  : {eng.customers_out(incidents)} out")
    print(f"incidents  : {len(incidents)} total, "
          f"{sum(1 for i in incidents.values() if i['status'] != 'restored')} active")
    for i in sorted(incidents.values(), key=lambda x: x['incident_id']):
        print(f"   {i['incident_id']}  {i['status']:9} {i['fault_type']:19} "
              f"{i['affected_kp']:4} kp  crew={i['crew_id'] or '-'}")
    for c in crews:
        print(f"   {c['crew_id']}  {c['status']:9} @ {c['lat']},{c['lon']}  inc={c['current_incident_id'] or '-'}")
    db.close()


def cmd_run(args):
    eng = Engine(args.scenario, auto=args.auto)
    db = Db()
    if not _state(db, eng.scenario["id"]):
        eng.seed(db)
        print("Seeded (no prior state).")
    if args.speed is not None:
        db.update("ScenarioStates", {"scenario_id": eng.scenario["id"]},
                  {"speed": args.speed, "updated_at": datetime.now()})
    if args.play:
        db.update("ScenarioStates", {"scenario_id": eng.scenario["id"]},
                  {"playing": 1, "status": "running", "updated_at": datetime.now()})

    httpd = None
    if args.serve:
        from .server import start_server
        control_db = Db()

        def on_control(payload):
            path = payload.get("_path", "")
            action = payload.get("action")
            now = datetime.now()
            sid = {"scenario_id": eng.scenario["id"]}
            if path.startswith("/dispatch"):
                control_db.insert("Assignments", {
                    "id": str(uuid.uuid4()),
                    "incident_id": payload["incident_id"],
                    "crew_id": payload["crew_id"],
                    "action": payload.get("action", "dispatch"),
                    "eta_min": int(payload.get("eta_min", 0)),
                    "ts": now,
                })
                return {"ok": True}
            if action == "play":
                control_db.update("ScenarioStates", sid, {"playing": 1, "status": "running", "updated_at": now})
            elif action == "pause":
                control_db.update("ScenarioStates", sid, {"playing": 0, "status": "paused", "updated_at": now})
            elif action == "speed":
                control_db.update("ScenarioStates", sid, {"speed": float(payload["value"]), "updated_at": now})
            elif action == "reset":
                eng.reset(control_db)
            else:
                return {"ok": False, "error": "unknown action"}
            return {"ok": True}

        httpd = start_server(args.port, lambda: eng.snapshot, on_control)
        print(f"Dev state/control server on http://127.0.0.1:{args.port}")

    print(f"Simulator running (auto={args.auto}, tick={args.tick}s). Ctrl+C to stop.")
    last_print = 0.0
    try:
        while True:
            try:
                info = eng.tick(db, args.tick)
            except Exception as e:  # token expiry / transient TDS -> reconnect
                print(f"[reconnect] {e}")
                db.close()
                time.sleep(2)
                db = Db()
                continue
            now = time.time()
            if now - last_print >= 2 and not info.get("idle"):
                print(f"  t+{info.get('elapsed_min','?')}min  "
                      f"out={info.get('customers_out','?')}  "
                      f"active={info.get('active','?')}  status={info.get('status','?')}")
                last_print = now
            if info.get("status") == "done":
                print("Scenario complete.")
                if args.exit_on_done:
                    break
            time.sleep(args.tick)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        db.close()
        if httpd:
            httpd.shutdown()


def main(argv=None):
    p = argparse.ArgumentParser(prog="simulator")
    p.add_argument("--scenario", default="mauri-2026")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("seed").set_defaults(func=cmd_seed)
    sub.add_parser("reset").set_defaults(func=cmd_reset)
    sub.add_parser("play").set_defaults(func=cmd_play)
    sub.add_parser("pause").set_defaults(func=cmd_pause)
    sub.add_parser("status").set_defaults(func=cmd_status)

    sp = sub.add_parser("set-speed")
    sp.add_argument("value", type=float)
    sp.set_defaults(func=cmd_set_speed)

    dp = sub.add_parser("dispatch")
    dp.add_argument("incident")
    dp.add_argument("crew")
    dp.add_argument("--action", default="dispatch", choices=["dispatch", "cancel"])
    dp.set_defaults(func=cmd_dispatch)

    rp = sub.add_parser("run")
    rp.add_argument("--auto", action="store_true", help="auto-dispatch nearest skilled crew")
    rp.add_argument("--speed", type=float, default=None)
    rp.add_argument("--tick", type=float, default=1.0)
    rp.add_argument("--play", action="store_true", help="start playing immediately")
    rp.add_argument("--exit-on-done", action="store_true")
    rp.add_argument("--serve", action="store_true", help="expose dev state/control HTTP server")
    rp.add_argument("--port", type=int, default=8787)
    rp.set_defaults(func=cmd_run)

    args = p.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
