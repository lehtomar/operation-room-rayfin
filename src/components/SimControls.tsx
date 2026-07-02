import type { Scenario } from '../lib/types';

const SPEEDS = [8, 24, 60];

interface SimControlsProps {
  scenario: Scenario | null;
  auto: boolean;
  onPlay: () => void;
  onPause: () => void;
  onSpeed: (v: number) => void;
  onToggleAuto: () => void;
  onReset: () => void;
}

/** Floating playback controls for the storm replay (over the map). */
export function SimControls(props: SimControlsProps) {
  const playing = props.scenario?.playing ?? false;
  const speed = props.scenario?.speed ?? 24;
  return (
    <div className="sim-controls">
      <button className="pbtn" onClick={playing ? props.onPause : props.onPlay} title={playing ? 'Pause' : 'Play'}>
        {playing ? '⏸' : '▶'}
      </button>
      <div className="speeds">
        {SPEEDS.map((s) => (
          <button key={s} className={`sbtn ${Math.round(speed) === s ? 'active' : ''}`} onClick={() => props.onSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
      <button
        className={`sbtn auto ${props.auto ? 'active' : ''}`}
        onClick={props.onToggleAuto}
        title="Auto-dispatch nearest skilled crew"
      >
        AUTO
      </button>
      <button className="pbtn reset" onClick={props.onReset} title="Reset scenario">
        ⟲
      </button>
    </div>
  );
}
