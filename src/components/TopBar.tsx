import type { Scenario, Wind } from '../lib/types';
import { windArrow } from '../lib/wind';
import type { FmiWind } from '../hooks/useFmiWind';

export interface Kpis {
  customersOut: number;
  activeFaults: number;
  crewsDispatched: number;
  compensationEur: number;
}

interface TopBarProps {
  scenario: Scenario | null;
  kpis: Kpis;
  stormName: string;
  wind: Wind | null;
  fmiWind: FmiWind | null;
  connected: boolean;
  canReset: boolean;
  onPlay: () => void;
  onPause: () => void;
  onSpeed: (v: number) => void;
  onReset: () => void;
}

const SPEEDS = [12, 24, 48, 96];
const nf = new Intl.NumberFormat('fi-FI');

function clock(iso: string | undefined): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  return d.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });
}

export function TopBar(props: TopBarProps) {
  const { scenario, kpis, wind, fmiWind } = props;
  const playing = scenario?.playing ?? false;
  const speed = scenario?.speed ?? 24;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">⚡</span>
        <div>
          <div className="brand-title">VERKKOVAHTI</div>
          <div className="brand-sub">Sysmä · käyttökeskus</div>
        </div>
      </div>

      <div className="kpis">
        <Kpi label="Käyttöpaikkaa pimeänä" value={nf.format(kpis.customersOut)} tone="danger" />
        <Kpi label="Aktiivista vikaa" value={String(kpis.activeFaults)} tone="warn" />
        <Kpi label="Partiota kentällä" value={String(kpis.crewsDispatched)} />
        <Kpi label="Vakiokorvausriski" value={`${nf.format(kpis.compensationEur)} €`} tone="danger" />
      </div>

      <div className="storm">
        <span className={`badge ${playing ? 'badge-live' : ''}`}>MYRSKY {props.stormName.toUpperCase()}</span>
        <div className="wind-chip" title="Skenaarion tuuli (myrskyrintama)">
          <span className="wind-arrow" style={{ transform: `rotate(${(wind?.dir_deg ?? 0) + 180}deg)` }}>↑</span>
          <span className="wind-val">{wind ? wind.speed_ms.toFixed(0) : '–'}</span>
          <span className="wind-unit">m/s</span>
          <span className="wind-gust">puuska {wind ? wind.gust_ms.toFixed(0) : '–'}</span>
          <span className="wind-dir">{wind ? windArrow(wind.dir_deg) : ''}</span>
        </div>
        <div className="wind-chip fmi" title="FMI live -havainto">
          <span className="fmi-tag">FMI</span>
          <span className="wind-val">{fmiWind?.speed_ms != null ? fmiWind.speed_ms.toFixed(0) : '–'}</span>
          <span className="wind-unit">m/s</span>
        </div>
      </div>

      <div className="player">
        <div className="sim-clock" title="Simuloitu kello">
          <span className="sim-time">{clock(scenario?.sim_clock)}</span>
          <span className={`conn-dot ${props.connected ? 'ok' : 'bad'}`} />
        </div>
        <button className="pbtn" onClick={playing ? props.onPause : props.onPlay}>
          {playing ? '⏸' : '▶'}
        </button>
        <div className="speeds">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={`sbtn ${Math.round(speed) === s ? 'active' : ''}`}
              onClick={() => props.onSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
        {props.canReset && (
          <button className="pbtn reset" onClick={props.onReset} title="Nollaa skenaario">
            ⟲
          </button>
        )}
      </div>
    </header>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'warn' }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}
