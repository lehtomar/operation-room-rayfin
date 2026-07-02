import { entity, authenticated, uuid, text, int, date } from '@microsoft/rayfin-core';

/**
 * Append-only dispatch action log. Written by the frontend on
 * Suggest→Confirm / drag-to-dispatch (optimistic UI), read by the simulator
 * to move the assigned crew to the incident site.
 * `action`: dispatch | cancel
 */
@entity()
@authenticated('*')
export class Assignment {
  @uuid() id!: string;
  @text({ max: 40 }) incident_id!: string;
  @text({ max: 20 }) crew_id!: string;
  @text({ max: 20 }) action!: string;
  @int() eta_min!: number;
  @date() ts!: Date;
}
