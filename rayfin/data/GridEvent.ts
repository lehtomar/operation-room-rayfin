import { entity, authenticated, uuid, text, date } from '@microsoft/rayfin-core';

/**
 * Append-only grid event log — the clean, integration-ready event schema a
 * real SCADA/DMS (or a Fabric Eventstream) would slot into. Mirrors the KQL
 * `grid_events` template in src/queries/.
 * `event_type`: fault | restoration | crew_status | transformer_status
 * `payload`: small JSON string (< 400 chars)
 */
@entity()
@authenticated('*')
export class GridEvent {
  @uuid() id!: string;
  @date() ts!: Date;
  @text({ max: 30 }) event_type!: string;
  @text({ max: 40 }) entity_id!: string;
  @text({ max: 20, optional: true }) feeder_id?: string;
  @text({ max: 400, optional: true }) payload?: string;
}
