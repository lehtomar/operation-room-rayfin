# DEPLOY.md — deploy & redeploy Verkkovahti on Microsoft Fabric

Everything a Fabric field team needs to redeploy this control room, including
against **another municipality**.

## 1. Prerequisites

- A Fabric workspace on a capacity, with **Fabric Apps (preview)** enabled by a
  tenant admin (Admin portal → Tenant settings).
- **Node 20+**, **Python 3.11+**, **Azure CLI** (`az login`), and the Microsoft
  **ODBC Driver 18 for SQL Server**.
- `npm install` and the Python requirements installed
  (`tools/gridgen/requirements.txt`, `simulator/requirements.txt`).

## 2. Deploy the Rayfin data app

```bash
npx rayfin login
npx rayfin up --workspace-id <WORKSPACE_GUID>      # builds frontend, deploys, applies schema
npx rayfin up status                               # endpoint health
```

`rayfin up` is idempotent — it creates the data app on first run and updates the
same item afterward. It provisions a child **SQL Database**, applies the schema
from `rayfin/data/*.ts`, deploys the static frontend, and records everything in
`rayfin/.deployments.json`. Schema-affecting changes may need `--force` (it
allows destructive column changes — review first).

## 3. Get the SQL Database connection (for the simulator)

The simulator writes over **TDS** with an Entra token. Fetch the connection
string from the Fabric REST API:

```bash
TOKEN=$(az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv)
# find the child SQLDatabase item id, then:
curl -H "Authorization: Bearer $TOKEN" \
  https://api.fabric.microsoft.com/v1/workspaces/<WS>/SQLDatabases/<SQLDB_ID> | jq .properties
```

Copy `serverFqdn` + `databaseName` into `config/db.local.json`
(from `config/db.example.json`). The simulator authenticates with
`az account get-access-token --resource https://database.windows.net/` — no
secret is stored.

## 4. Run the demo

```bash
python -m simulator seed                 # crews at depots, scenario idle
python -m simulator run                  # drives the storm (writes TDS)
```

Open the app **inside the Fabric portal** (Fabric SSO) and use the top-bar
player (▶ / speed) — those controls write `ScenarioStates` via GraphQL and the
simulator obeys. `python -m simulator reset` replays. For a **local** demo
without the portal, use `python -m simulator run --serve` + `npm run dev:web`
(see README step-by-step).

> Note: the deployed static app served *outside* the Fabric portal cannot sign
> in (Fabric SSO requires the portal iframe); open it from the workspace item.

---

## Redeploy against another municipality

The app is single-municipality but **config-driven**, so pointing it at a new
municipality is data + config, not code.

1. **Get MML data.** Download the Maastotietokanta shapefiles covering the target
   municipality into `mml-data/<SHEET>/` (needs at least `HallintoAlue`,
   `RakennusPiste`, `TieViiva`, `SahkoPiste`). Keep EPSG:3067.

2. **Add a municipality config.** Copy `config/municipality.sysma.json` to
   `config/municipality.<id>.json` and edit: `name`, `kuntaCode`, `map.center`,
   `map.bboxTM35FIN`, `gridgen.mmlDataDir`, `gridgen.substations[].seedPlaceName`,
   `gridgen.feederCount`, the `compensation` tiers/fee, and `fmi.place`.

3. **Generate the grid.**
   ```bash
   MUNICIPALITY=<id> python tools/gridgen/gridgen.py
   MUNICIPALITY=<id> python -m pytest tools/gridgen -q     # verify topology
   ```
   Outputs land in `tools/gridgen/output/`.

4. **Author a scenario.** Copy `scenarios/mauri-2026.json` to
   `scenarios/<storm>.json`, pick real `seg_id`s from
   `tools/gridgen/output/feeders.parquet` (root segments = whole-feeder trips),
   set crew depots, skills and shift. Run any command with `--scenario <storm>`.

5. **Build + deploy.**
   ```bash
   MUNICIPALITY=<id> npm run build
   npx rayfin up --workspace-id <WORKSPACE_GUID>
   ```
   `scripts/sync-assets.mjs` (run in `prebuild`) bundles the selected
   municipality + grid into `public/data`.

That's it — the data model, topology, simulator, calculators and UI are all
municipality-agnostic.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `rayfin up` deploys to "My Workspace" | pass `--workspace-id <GUID>` explicitly |
| Simulator: no Entra token | `az login`; token resource is `https://database.windows.net/` |
| `Internal server error` after deploy | a `@text()` field is missing `max` (NVARCHAR(MAX)) — add `max` and redeploy |
| Deployed app shows no data | open it **inside the Fabric portal** (Fabric SSO), and ensure the simulator is running |
| Endpoint unreachable | re-run `npx rayfin up`; check `npx rayfin up status` |
