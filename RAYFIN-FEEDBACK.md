# Rayfin feedback from Gridwatch

## Executive summary

Rayfin made the shortest part of Gridwatch's journey the part that is usually
the hardest: turning a TypeScript data model into an authenticated Fabric
application with a SQL database, GraphQL API, and deployed frontend.

The core developer loop worked well:

```text
@entity model → rayfin up → Fabric SQL + Data API Builder + static app
```

The main friction appeared where Gridwatch became more than a CRUD application:
continuous simulation, headless ingestion, public/local reads, and Real-Time
Intelligence integration. We solved each issue, but the workarounds shaped the
architecture.

## At a glance

| Area | Experience | Evidence from Gridwatch |
|---|---|---|
| Code-first data model | Excellent | Six entities compiled into Fabric SQL and Data API Builder configuration |
| Full deployment | Excellent | One idempotent `rayfin up` applied schema, built Vite, and deployed static assets |
| Frontend data access | Good | Typed `client.data.<Entity>` queries and mutations were straightforward |
| Fabric authentication | Good | Generated environment variables aligned with Fabric SSO helpers |
| Local development | Needs improvement | Fabric-authenticated data is unavailable outside the portal |
| Headless ingestion | Needs documentation | The Python simulator required direct TDS writes with an Entra token |
| Background compute | Not evaluated | Fabric Functions are available in private preview, but I unfortunately did not have time to test them during the hackathon |
| Real-Time Intelligence | Incomplete path | Rayfin's browser data plane targets SQL/DAB, not Eventhouse/KQL |

## What worked especially well

### 1. One command delivered a complete Fabric application

`npx rayfin up` reused the existing Fabric item, generated and applied the DAB
configuration, built the React application, deployed static content, updated
redirect URIs, and recorded deployment metadata. Repeated deployments were
predictable and safe.

### 2. The code-first model stayed understandable

Rayfin entities made the operational schema easy to review alongside the
application:

- crews and shifts
- incidents and restoration state
- assignments
- grid events
- scenario state

This was much faster than separately provisioning a database, authoring an API,
and wiring authentication.

### 3. Production auth and typed GraphQL felt cohesive

`rayfin env` generated the Vite and Fabric settings expected by the scaffold.
`initEmbeddedAuth` handled the portal experience, while the typed SDK kept
frontend queries and mutations close to the domain model.

### 4. Rayfin left room for standard Fabric access

The managed data app provisioned a real Fabric SQL Database. That allowed the
headless Python simulator to write over TDS using an Entra token when browser
GraphQL authentication was not suitable.

## Where the architecture had to adapt

| Challenge | Effect on Gridwatch | Workaround | Recommended platform capability |
|---|---|---|---|
| No evaluated background job or function | The deployed storm simulation had nowhere to run using the tested platform path | Moved the simulation engine into the browser | Validate whether the Fabric Functions private preview supports scheduled or continuous jobs with Rayfin database access |
| No anonymous/read-only Fabric role | Local Vite could not read deployed data | Used a local provider and self-contained browser data | Publishable-key read roles or an official local development proxy |
| No documented service-to-service write path | A headless simulator could not use Fabric SSO GraphQL | Connected directly to Fabric SQL over TDS with an Entra token | Documented managed identity/service principal ingestion and surfaced SQL connection details |
| No direct Eventhouse client path | RTI could not be the browser's primary data plane | Used SQL/DAB and kept KQL assets as an RTI-ready path | Authenticated Eventhouse/KQL queries through Rayfin or a documented proxy |
| `@decimal()` defaulted to scale 2 | Latitude and longitude lost roughly kilometre-level precision | Stored coordinates as bounded text and parsed them | Configurable precision/scale plus geospatial types |
| Version-locked docs required installed packages | Docs MCP was empty during initial scaffolding | Used the bundled skill and package discovery first | Fall back to latest docs with a clear version warning |

## Highest-impact recommendations

1. **Document the Fabric Functions path for Rayfin.** Fabric Functions are in
   private preview, but I unfortunately did not have time to test them during
   the hackathon. Clear guidance on Rayfin database access, scheduling, and
   continuous workloads would show whether they close the compute gap.
2. **Make machine-to-machine access first-class.** Support managed identity or
   service-principal writes and expose the SQL endpoint in deployment status.
3. **Improve the local data loop.** Provide a safe read-only role or a CLI proxy
   so frontend development can use realistic Fabric data outside the portal.
4. **Connect Rayfin to Fabric RTI.** A typed Eventhouse/KQL read client would
   unlock operational dashboards without maintaining a parallel SQL data plane.
5. **Strengthen data-type controls.** Precision/scale options and geospatial
   primitives would prevent silent quality loss in mapping and financial apps.

## What these improvements would remove

With background compute, service authentication, and a local read path,
Gridwatch could use one architecture everywhere:

```text
weather/grid events → hosted Rayfin job → Fabric data plane → authenticated UI
```

Instead, the hackathon build needed three execution paths:

- a browser simulation for the portable deployed demo
- a Python/TDS simulator for server-side operation
- a local provider for frontend development

The application works, but those paths represent complexity the platform could
eliminate.

## Final verdict

Rayfin is already compelling for authenticated, data-centric Fabric
applications. It gave Gridwatch a real database, API, authentication, and
hosting with very little infrastructure code.

Its next opportunity is to support the full lifecycle of operational and
real-time applications—not only their schema and user interface, but also the
background processes and ingestion identities that keep them alive.

**In one sentence:** Rayfin made Gridwatch easy to deploy; first-class compute
and service access would make the entire architecture equally simple.
