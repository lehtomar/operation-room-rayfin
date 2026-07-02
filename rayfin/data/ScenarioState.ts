import { entity, authenticated, uuid, text, decimal, boolean, date } from '@microsoft/rayfin-core';

/**
 * Single-row scenario-player state, driven by the simulator control API and
 * read by the frontend top bar. `sim_clock` is the compressed storm time.
 * `status`: idle | running | paused | done
 */
@entity()
@authenticated('*')
export class ScenarioState {
  @uuid() id!: string;
  @text({ max: 40 }) scenario_id!: string;
  @date() sim_clock!: Date;
  @boolean() playing!: boolean;
  @decimal() speed!: number;
  @text({ max: 20 }) status!: string;
  @date() updated_at!: Date;
}
