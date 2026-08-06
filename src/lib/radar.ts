import type { ScenarioMeta } from './types';

export type RadarReplay = NonNullable<ScenarioMeta['radarReplay']>;

export function replayRadarFrames(replay: RadarReplay, stride = 1): Date[] {
  const start = new Date(replay.start).getTime();
  const end = new Date(replay.end).getTime();
  const step = replay.stepMinutes * 60000 * stride;
  if (!Number.isFinite(start) || !Number.isFinite(end) || step <= 0 || end < start) {
    throw new Error('Invalid replay radar timeline.');
  }
  const frames: Date[] = [];
  for (let time = start; time <= end; time += step) frames.push(new Date(time));
  return frames;
}

export function replayRadarFrameMs(
  replay: RadarReplay,
  elapsedMs: number,
  simulationDurationMs: number
): number {
  const start = new Date(replay.start).getTime();
  const end = new Date(replay.end).getTime();
  const progress =
    simulationDurationMs > 0 ? Math.min(1, Math.max(0, elapsedMs / simulationDurationMs)) : 0;
  const raw = start + (end - start) * progress;
  const step = replay.stepMinutes * 60000;
  return Math.min(end, Math.max(start, Math.round((raw - start) / step) * step + start));
}

export function radarFrameKey(timeIso: string): string {
  return new Date(timeIso).toISOString().replace(/[-:]/g, '').replace('.000', '');
}
