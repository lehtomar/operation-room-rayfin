# Verkkovahti demo guide

Verkkovahti works as two presenter modes in one screen:

- **NORMAL OPERATIONS ("blue-sky day")** — the **Live** view: an ordinary Sysmä
  shift with two crews out on **scheduled maintenance** and a couple of small
  **unscheduled outages** waiting for dispatch. The live clock runs, so crews you
  dispatch actually drive to site along the road network.
- **STORM demo: Myrsky Mauri** — the **Storm replay** view: press play to run the
  scripted NW→SE storm over Sysmä: ~4 h simulated time compressed into a ~10 min
  operations demo.

The deployed demo runs **entirely client-side in the browser**. `SimDriver` uses the bundled `scenarios/mauri-2026.json` scenario plus topology assets, so no backend process is needed to present.

## Normal operations demo script

**Goal:** show what a Finnish DSO dispatcher sees before the storm and why this shared operating picture matters. Estimated time: **3–5 min**.

1. **Set the scene (0:20)**  
   Switch to the **Live** view. Point to the amber **MINOR DISTURBANCE** badge — an ordinary shift: mostly calm, a couple of small faults in hand, crews out on planned work.

2. **Read the KPI strip (0:20)**  
   Point to the KPIs: a few dozen **customers without power** from the small outages, **2 active faults**, **2/6 crews dispatched** (both on maintenance), and a modest **compensation risk €**. Mention that compensation risk is Finnish **vakiokorvaus** exposure and stays small on a normal day.

3. **Show the energized grid (0:30)**  
   Point to the solid green medium-voltage feeders. Say: "All feeders are energized; nothing is dashed red, so no downstream area is out."

4. **Orient the audience in Sysmä (0:30)**  
   Point out the two substations: **Sysmä** and **Nuoramoinen**. Explain that the radial topology lets the dispatcher understand which käyttöpaikat would be affected if a feeder section failed.

5. **Check transformers and feeders (0:25)**  
   Point/click around a healthy feeder or transformer area. Nothing opens as an actionable fault because the assets are OK; contrast this with the storm mode, where clicking a fault opens a detail panel and downstream highlight.

6. **Show field readiness (0:30)**  
   Point to the **Field Crews Gantt**. Two crews are on **scheduled maintenance** (blue blocks with an estimated completion time); the rest are **AVAILABLE** at their depots on the 14:00–22:00 shift.

7. **Work the incident queue (0:40)**  
   Point to the incident queue: two small **unscheduled** outages ranked by impact (käyttöpaikat × outage hours). Click **SUGGEST DISPATCH** on one, or drag its card onto an available crew row. The live clock is running, so the crew drives to site along the road network and the incident closes when repair completes.

8. **Talk through weather awareness (0:30)**  
   Point to the **Wind** chip. In the Live view it shows live **FMI** wind for Sysmä; the dispatcher watches it because weather is an early signal for readiness. (In Storm replay the same chip shows the scenario's storm wind.)

9. **Demonstrate map context (0:35)**  
   Use the basemap switch: **Map / Dark / Satellite**. Explain when each is useful: Map for operations, Dark for control-room contrast, Satellite for terrain and access context.

10. **Demonstrate layers and legend (0:30)**  
    Open the layer-toggle panel and legend. Toggle **MV feeders**, **Transformers**, **Faults**, **Crews & routes**, and the **Rain radar** to show that the same view can be simplified for different dispatcher questions.

11. **Everyday DSO message (0:30)**  
    Summarize: a dispatcher maintains situational awareness, watches weather and grid state, keeps crews ready, and makes fast dispatch decisions only when incidents appear.

12. **Reusability message (0:20)**  
    Close the normal-ops section by noting that Sysmä is configured data: the same Rayfin app pattern can be reused across municipalities by changing municipality/grid/scenario configuration.

## Transition into Myrsky Mauri

**Cue:** "Now the blue-sky day turns into the scripted storm exercise."

- Switch to the **Storm replay** view (top-bar toggle).
- Press **▶** on the floating sim-control bar over the map.
- Pick **24×** for a steady walkthrough or **60×** when time is short; **8×** is useful when explaining details slowly.
- Optionally turn **AUTO** on to auto-assign the nearest skilled crew.
- Use **⟲ Reset** if you need to replay from the idle state.

For the storm walkthrough, use the **10-step demo script in `README.md`** rather than duplicating it here. It covers the Myrsky Mauri front moving NW→SE, seven faults including the ~639-käyttöpaikka feeder trip and remote lakeside fault, fault detail panel with **Suggest dispatch**, incident-card drag-and-drop onto the Field Crews Gantt, road-based crew travel, restoration, and KPI recovery.

## Story arc: situational awareness → response

- **Normal operations** proves the control room is useful before anything breaks: energized grid, calm weather, idle crews, empty queue, and KPIs near zero.
- **Storm response** shows the same view under pressure: faults appear, käyttöpaikat lose power, vakiokorvaus risk grows, crews are dispatched, and restoration is tracked.
- Together they tell the complete DSO operations story: **monitor continuously, detect quickly, prioritize impact, dispatch crews, restore service**.
- Because the simulation runs client-side in the browser from bundled scenario and topology assets, the demo is portable: it can be shown anywhere the deployed Rayfin app opens, with **no backend simulator** to start.
