import { entity, authenticated, uuid, text, int, date } from '@microsoft/rayfin-core';

/**
 * A fault incident on a feeder segment. Created by the simulator; `status`,
 * `crew_id` and `eta_min` are updated by dispatch (frontend GraphQL) and by
 * the simulator as crews progress / power is restored.
 * `fault_type`: tree_on_line | broken_pole | transformer_failure
 * `status`: open | assigned | enroute | onsite | restored
 */
@entity()
@authenticated('*')
export class Incident {
  @uuid() id!: string;
  @text({ max: 40 }) incident_id!: string;
  @text({ max: 40 }) seg_id!: string;
  @text({ max: 20 }) feeder_id!: string;
  @text({ max: 40 }) ss_id!: string;
  @text({ max: 30 }) fault_type!: string;
  @int() affected_kp!: number;
  @int() affected_tr!: number;
  @int() repair_effort_min!: number;
  @text({ max: 20 }) status!: string;
  @text({ max: 20, optional: true }) crew_id?: string;
  @int({ optional: true }) eta_min?: number;
  @date() started_at!: Date;
  @date({ optional: true }) restored_at?: Date;
  @date() updated_at!: Date;
}
