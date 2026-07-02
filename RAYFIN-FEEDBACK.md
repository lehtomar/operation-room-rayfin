# RAYFIN-FEEDBACK.md

A first-class deliverable. Dated log of friction, missing capabilities,
confusing APIs, workarounds, and pleasant surprises while building Verkkovahti
on Rayfin + Microsoft Fabric. Format per entry: **what I tried → what happened →
what I did instead → what the platform should do**.

---

## 2026-07-02 — Project bootstrap & planning

### Surprise (mild): fresh scaffold, no reusable app
- **Tried**: locate the "existing wind-farm digital twin" Rayfin app to reuse its
  conventions (map stack, KQL helpers, deploy scripts) as the spec instructed.
- **Happened**: `rayfin/` is a *bare* scaffold — `rayfin.yml`, `.env`,
  `.deployments.json`, empty `data/`, `tsconfig.json`. No `src/`, no
  `package.json`, no `schema.ts`, no frontend, no KQL. Nothing to reuse beyond
  the scaffold + the `rayfin` skill/MCP.
- **Instead**: building the React/MapLibre frontend and data model from scratch
  inside `rayfin/`.
- **Platform should**: templates/starters for common shapes (map + polling data
  app) would jump-start this class of project.

### Friction: docs MCP returns empty on a scaffold with no `node_modules`
- **Tried**: `search_docs` / `list_docs` (guide + ts-sdk) for Fabric SQL access,
  data-write, known limitations.
- **Happened**: all returned `[]`. `discover_packages` *did* work (registry
  query) and surfaced `@microsoft/rayfin-core` (DAB) and
  `@microsoft/rayfin-auth-provider-fabric`.
- **Cause**: docs are version-locked to installed packages; a scaffold with no
  `package.json`/`node_modules` has nothing to serve.
- **Instead**: relying on the bundled `SKILL.md` + `discover_packages` until deps
  are installed; will re-query docs after `npm install`.
- **Platform should**: fall back to latest-published docs (with a clear "not
  version-locked" banner) when no local packages are installed.

### Architecture tension: RTI showcase vs Rayfin's SQL data plane
- **Tried**: reconcile the spec's Fabric Real-Time Intelligence story
  (Eventstream → Eventhouse/KQL) with Rayfin, whose only data plane is a Fabric
  SQL DB exposed via Data API Builder (GraphQL/REST). There is no
  KQL-from-browser access pattern in Rayfin.
- **Decision**: SQL-only on the demo path (simulator → SQL, frontend polls
  GraphQL). KQL schema kept as runnable *template assets* in `src/queries/`.
- **Platform should**: a first-class, authenticated read path from a Rayfin
  frontend to an Eventhouse/KQL endpoint (or a documented proxy pattern) would
  let RTI apps use Rayfin without a second data plane.

### Known hard spot (pre-registered): headless write into a Fabric-hosted DB
- **Plan**: simulator writes to the Fabric SQL DB directly over TDS
  (pyodbc/pymssql + Entra token from `az account get-access-token`). Rayfin's
  GraphQL write path needs an authenticated (Fabric SSO) session, impractical for
  a headless service.
- **Open risk**: whether the managed BaaS SQL DB exposes a reachable TDS
  endpoint / how to obtain its connection string. Fallback: bulk write via the
  DAB GraphQL endpoint with an `az`-minted bearer token, or a Fabric notebook
  writer. **Will update this entry with what actually worked.**
- **Platform should**: document (and ideally sanction) a service-principal /
  server-to-server write path for Rayfin data, for ingestion/simulator workloads.

## 2026-07-02 — M2: data model deploy & the TDS write path (the hard spot, resolved)

### Pleasant surprise: `rayfin up` is smoothly idempotent
- **Tried**: redeploy the schema onto the pre-existing (but unreachable) app
  backend after adding 5 entities.
- **Happened**: `rayfin up --workspace-id <ws> --exclude-services staticHosting`
  reused the same item id (`4f2dab30…`), regenerated + applied the DAB config in
  ~7 s, and brought the backend back. The dry-run text always says "Create
  Rayfin item" even when it updates — mildly confusing but harmless.
- **Platform should**: make dry-run distinguish create vs update; and read the
  active workspace from `.deployments.json` so `--workspace-id` isn't needed on
  every `up` (plain `up` defaulted to "My Workspace").

### RESOLVED: headless simulator CAN write over TDS
- **Tried**: find a write path for a headless Python simulator (GraphQL needs a
  Fabric-SSO bearer; publishable key can't write `@authenticated` entities).
- **Happened**: the Fabric data app provisions a real **SQL Database child item**
  (`type: SQLDatabase`, `SQLDbNative`). Its connection string is retrievable via
  `GET /v1/workspaces/{ws}/SQLDatabases/{id}` → `properties.connectionString` /
  `serverFqdn` / `databaseName`. Connecting with **pyodbc (ODBC Driver 18)** and
  an **Entra token** (`az account get-access-token --resource
  https://database.windows.net/`, packed into `attrs_before[1256]`) works — all
  entity tables are present (pluralized: `Crews`, `Incidents`, …) and writable.
- **Instead of** the GraphQL fallback, the simulator writes directly over TDS.
- **Platform should**: surface the SQL DB connection string in `rayfin up status`
  / `.deployments.json` (right now you must call the Fabric REST API for it), and
  document the "external writer over TDS with an Entra token" pattern — it's the
  natural fit for ingestion/simulator workloads.

### Friction: `@decimal()` silently defaults to scale 2 (≈1 km for lat/lon)
- **Tried**: `@decimal()` for crew `lat`/`lon`.
- **Happened**: the generated MSSQL column is `decimal(18,2)` — 2 dp, ~1.1 km at
  61°N. Map positions would snap to a coarse grid. `@decimal` has no documented
  `precision`/`scale` option.
- **Instead**: store coordinates as `@text({ max: 20 })` and parse floats.
- **Platform should**: document `@decimal` precision/scale options (or default to
  a higher scale), and note the (18,2) default prominently — it's a silent
  data-quality trap for geospatial/currency values.
