# simulator — storm scenario player

Headless Python service that replays a storm scenario into the Fabric-hosted
Rayfin SQL Database, so the frontend sees live grid + crew state via GraphQL
polling.

## Write path
Writes **directly to the Fabric SQL Database over TDS** (pyodbc + ODBC Driver 18)
using an **Entra token** (`az account get-access-token --resource
https://database.windows.net/`). The Rayfin GraphQL write path needs an
interactive Fabric-SSO session, impractical for a headless writer — see
`RAYFIN-FEEDBACK.md`. Connection details live in `config/db.local.json`
(gitignored; copy from `config/db.example.json`).

## Control channel
Player controls live in the single `ScenarioStates` row (`playing`, `speed`,
`status`, `sim_clock`). The frontend player and this simulator share that one
row, so `play`/`pause`/`set-speed`/`reset` work from either side.

## Commands
```bash
az login                                  # once
python -m pip install pyodbc              # + gridgen requirements
python -m simulator seed                  # crews + scenario-state at storm start
python -m simulator run --auto --play     # daemon loop (auto-dispatch on)
python -m simulator play | pause
python -m simulator set-speed 24          # sim-seconds per real-second
python -m simulator status                # KPIs + incidents + crews
python -m simulator dispatch INC-05 K-2   # write an Assignment (test dispatch)
python -m simulator reset                 # back to storm start (idle)
```

`--auto` self-dispatches the nearest available crew with the matching skill
(great for the idle/normal-ops demo). Without it, dispatch comes from the
frontend (or `dispatch` CLI) via the `Assignments` table — the same code path.

## Loop
Each tick: advance `sim_clock` by `dt × speed`; fire due faults (affected counts
from `tools/gridgen/output/topology.json`); apply `Assignments`; move crews along
a great-circle path (60 km/h, ×1.3 road factor); mark `onsite`; after
`repair_effort_min` sim-minutes emit a restoration and free the crew. Restored
segments re-energize (the frontend derives de-energized assets from active
incidents via the topology closure).

Default compression: 10 min demo ≈ 4 h simulated ⇒ `speed = 24`.
