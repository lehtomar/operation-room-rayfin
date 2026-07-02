# KQL template assets (`src/queries/`)

Named, standalone-runnable KQL for a Fabric **Eventhouse** — the "real-time-ready"
path and a reusable hackathon template. The Verkkovahti demo itself runs
**SQL-only** (the simulator writes to the Fabric SQL Database and the frontend
polls via Rayfin GraphQL), but these files mirror the SQL entities 1:1 so a
Fabric **Eventstream → Eventhouse** can be substituted without changing the
frontend contract.

| File | Purpose |
|------|---------|
| `00_schema.kql` | Create `grid_events`, `crew_telemetry`, `assignments` tables |
| `10_current_grid_state.kql` | `arg_max` per segment → energized / de-energized |
| `11_active_incidents.kql` | Active faults ranked by käyttöpaikat × elapsed |
| `12_crew_positions.kql` | `arg_max` per crew → latest position + status |
| `13_compensation_risk.kql` | Projected vakiokorvaus € (Sähkömarkkinalaki 588/2013) |

Each query materializes current state with `arg_max()` over the append-only
event log. The one thing KQL doesn't do here is de-duplicate overlapping feeder
segments — that uses the radial-topology closure (`shared/topology`), which both
the simulator and frontend consume. A server-side variant would join to a
reference topology table in the Eventhouse.
