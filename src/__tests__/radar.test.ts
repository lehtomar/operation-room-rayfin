import { describe, expect, it } from 'vitest';

import { radarFrameKey, replayRadarFrameMs, replayRadarFrames, type RadarReplay } from '../lib/radar';

const replay: RadarReplay = {
  start: '2026-07-09T08:00:00Z',
  end: '2026-07-09T12:00:00Z',
  stepMinutes: 5,
  bounds: [24.8, 61.1, 26.8, 62.0],
  path: 'radar/mauri-2026',
};

describe('replay radar archive', () => {
  it('uses the fixed archived frame range', () => {
    const frames = replayRadarFrames(replay);
    expect(frames).toHaveLength(49);
    expect(frames[0].getTime()).toBe(new Date(replay.start).getTime());
    expect(frames.at(-1)?.getTime()).toBe(new Date(replay.end).getTime());
  });

  it('maps simulation progress to deterministic five-minute frames', () => {
    const duration = 4 * 3600_000;
    expect(replayRadarFrameMs(replay, 0, duration)).toBe(new Date(replay.start).getTime());
    expect(new Date(replayRadarFrameMs(replay, duration / 2, duration)).toISOString()).toBe('2026-07-09T10:00:00.000Z');
    expect(replayRadarFrameMs(replay, duration, duration)).toBe(new Date(replay.end).getTime());
  });

  it('creates stable archive directory names', () => {
    expect(radarFrameKey('2026-07-09T08:05:00Z')).toBe('20260709T080500Z');
  });
});
