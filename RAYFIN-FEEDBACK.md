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

## 2026-07-02 — M3: the read path & a dual-provider workaround

### Friction: no unauthenticated read path → local frontend dev is blocked
- **Tried**: `@anonymous('read')` so the frontend could read live grid state
  with just the publishable key (enabling local dev + a public read-only demo).
- **Happened**: `anonymous` is exported only from
  `@microsoft/rayfin-core/experimental`, and its own docstring says *"Anonymous
  data access is not currently supported on Fabric: the CLI rejects any DAB
  configuration that grants the anonymous role at apply time."* So all reads
  require `@authenticated` (Fabric SSO), which only works **inside the Fabric
  portal** — you cannot read your own data from a local `vite` dev server.
- **Instead**: a **dual DataProvider**. In the Fabric portal, `RayfinProvider`
  reads/writes via authenticated GraphQL. For local dev, the simulator exposes a
  tiny HTTP server (`run --serve`) with `/state` + `/control` + `/dispatch`, and
  `DevProvider` talks to it (no auth). Same normalized shape both ways, so all
  KPI/de-energization logic is identical.
- **Platform should**: either support a publishable-key read-only role on Fabric,
  or ship a documented local dev proxy so builders can run their frontend against
  real data outside the portal. Today the local dev loop for a data app is rough.

### Pleasant: `rayfin env` + publishable key + docs made the prod path easy
- The generated `.env.local` (`VITE_RAYFIN_*`, `VITE_FABRIC_*`) matched the
  scaffold's `bootstrapAuth()` exactly, and `ensureSignedInWithFabric` /
  `initEmbeddedAuth` are the documented entry points. The production read/write
  code (`RayfinProvider`) was straightforward to write against the typed
  `client.data.<Entity>` API. (Validated end-to-end in the portal at M5.)

### Note: resilience — a WebGL/map failure must not blank the app
- MapLibre `new Map()` throwing in a `useEffect` (e.g. no WebGL) unmounts the
  whole React root with no error boundary. Wrapped map init in try/catch + an
  in-map fallback so KPIs and incident data keep working regardless. (Not
  Rayfin-specific, but a good default for any map-in-Fabric app.)

## 2026-07-02 — M5: static deploy, reconciliation, wrap-up

### Pleasant: full `rayfin up` static deploy was one clean command
- `npx rayfin up` built the Vite app, packaged 11 files (2.5 MB), deployed to
  OneLake-backed static hosting, applied the schema, and appended the hosting URL
  to `allowedRedirectUris` in `rayfin.yml` — all in one run. Hosting URL served
  `index.html`, `/data/*.geojson`, and `basemap.json` immediately (HTTP 200).

### Note: two writers on one DB, reconciled by polling
- The simulator writes state over TDS while the frontend writes dispatch
  `Assignment`s via GraphQL. The UI applies an **optimistic** "assigned" flip and
  clears it once the next poll shows the simulator has advanced the incident past
  `open`. This worked well; the only caveat is that `count()` isn't on the
  GraphQL client, so every KPI is computed client-side from `select()`ed rows +
  the static topology closure (fine at this scale).

### Note: the MML WMTS key ships in the deployed static bundle
- `basemap.local.json` is gitignored, but `sync-assets` copies it into
  `public/data/basemap.json`, which Vite bundles into `dist/` and the deploy
  uploads. That's acceptable for a browser-side WMTS key (it's used in tile
  requests anyway), but a Rayfin-native "public runtime config injected at deploy
  time" would be cleaner than baking client config into the static bundle.

### Overall
Rayfin made the **data model → deployed, schema-applied Fabric SQL DB** loop
genuinely fast (code-first `@entity`, one `rayfin up`, docs-in-MCP). The two
things that shaped the whole architecture were platform gaps, both logged above:
**no anonymous/public read on Fabric** (forced a dual dev/prod provider) and
**no sanctioned headless write path** (used TDS + Entra token). Address those two
and this class of real-time data app becomes dramatically simpler on Rayfin.
