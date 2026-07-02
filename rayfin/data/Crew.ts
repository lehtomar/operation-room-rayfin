import { entity, authenticated, uuid, text, date } from '@microsoft/rayfin-core';

/**
 * Field crew. Current position/status is upserted by the simulator (over TDS);
 * dispatch fields are updated by the frontend via GraphQL.
 * `status`: idle | enroute | onsite | returning | offshift
 * `skills`: comma-separated subset of hv,tree,line
 * Coordinates are stored as text (WGS84 decimal degrees) because `@decimal`
 * defaults to scale 2 (~1 km), too coarse for map positions.
 */
@entity()
@authenticated('*')
export class Crew {
  @uuid() id!: string;
  @text({ max: 20 }) crew_id!: string;
  @text({ max: 40 }) callsign!: string;
  @text({ max: 60 }) skills!: string;
  @text({ max: 20 }) depot_lat!: string;
  @text({ max: 20 }) depot_lon!: string;
  @text({ max: 20 }) lat!: string;
  @text({ max: 20 }) lon!: string;
  @text({ max: 20 }) status!: string;
  @date() shift_start!: Date;
  @date() shift_end!: Date;
  @text({ max: 40, optional: true }) current_incident_id?: string;
  @date() updated_at!: Date;
}
