import type { Scenario, Wind } from '../lib/types';
import { windArrow } from '../lib/wind';
import type { FmiWind } from '../hooks/useFmiWind';

export interface Kpis {
  customersOut: number;
  activeFaults: number;
  crewsDispatched: number;
  compensationEur: number;
}

export interface KpiSub {
  totalKp: number;
  pctOut: number;
  unassigned: number;
  restored: number;
  lastRestored: string | null;
  crewsTotal: number;
  crewsAvailable: number;
  minsToFirstTier: number | null;
}

interface TopBarProps {
  scenario: Scenario | null;
  kpis: Kpis;
  sub: KpiSub;
  stormName: string;
  wind: Wind | null;
  fmiWind: FmiWind | null;
  auto: boolean;
  onToggleAuto: () => void;
  onPlay: () => void;
  onPause: () => void;
  onSpeed: (v: number) => void;
  onReset: () => void;
}

const SPEEDS = [8, 24, 60];
const nf = new Intl.NumberFormat('fi-FI');

function clock(iso: string | undefined | null): string {
  if (!iso) return '--:--';
  return new Date(iso).toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });
}
function dateStr(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function hm(mins: number | null): string {
  if (mins == null || mins <= 0) return '—';
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h} h ${mins % 60} min` : `${mins} min`;
}

export function TopBar(props: TopBarProps) {
  const { scenario, kpis, sub, wind, fmiWind } = props;
  const playing = scenario?.playing ?? false;
  const speed = scenario?.speed ?? 24;
  const stormActive = kpis.activeFaults > 0;

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-title">VERKKOVAHTI</div>
        <div className="brand-sub">GRID OPERATIONS · DSO</div>
      </div>

      <div className="player">
        <span className="sim-label">SIM</span>
        <button className="pbtn" onClick={playing ? props.onPause : props.onPlay}>
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

      <div className="kpis">
        <Kpi
          label="Customers without power"
          value={nf.format(kpis.customersOut)}
          tone="danger"
          sub={`of ${nf.format(sub.totalKp)} käyttöpaikkaa · ${sub.pctOut.toFixed(1)} %`}
        />
        <Kpi
          label="Active faults"
          value={String(kpis.activeFaults)}
          tone="warn"
          sub={`${sub.unassigned} unassigned · ${sub.restored} restored${sub.lastRestored ? ' ' + clock(sub.lastRestored) : ''}`}
        />
        <Kpi
          label="Crews dispatched"
          value={`${kpis.crewsDispatched}/${sub.crewsTotal}`}
          sub={`${sub.crewsAvailable} available at depot`}
        />
        <Kpi
          label="Compensation risk"
          value={`${nf.format(kpis.compensationEur)} €`}
          tone="danger"
          sub={sub.minsToFirstTier != null ? `first 12 h threshold in ${hm(sub.minsToFirstTier)}` : 'no active outages'}
        />
      </div>

      <div className="storm">
        <div className="wind-chip" title="Scenario storm wind">
          <span className="wind-lbl">WIND {wind ? windArrow(wind.dir_deg) : ''} · GUSTS</span>
          <span className="wind-arrow" style={{ transform: `rotate(${(wind?.dir_deg ?? 0) + 180}deg)` }}>↑</span>
          <span className="wind-val">{wind ? wind.gust_ms.toFixed(0) : '–'}</span>
          <span className="wind-unit">m/s</span>
        </div>
        <div className="wind-chip fmi" title="FMI live observation">
          <span className="fmi-tag">FMI</span>
          <span className="wind-val">{fmiWind?.speed_ms != null ? fmiWind.speed_ms.toFixed(0) : '–'}</span>
          <span className="wind-unit">m/s</span>
        </div>
        {stormActive ? (
          <div className={`badge major ${playing ? 'badge-live' : ''}`}>
            <span className="dot" /> MAJOR DISTURBANCE
            <span className="badge-sub">Storm {props.stormName} · FMI orange</span>
          </div>
        ) : (
          <div className="badge badge-ok">
            <span className="dot" /> NORMAL OPERATIONS
          </div>
        )}
      </div>

      <div className="clockbox">
        <span className="conn-dot ok" title="Live (in-browser engine)" />
        <div>
          <div className="sim-time">{clock(scenario?.sim_clock)}</div>
          <div className="sim-date">{dateStr(scenario?.sim_clock)}</div>
        </div>
      </div>
    </header>
  );
}

function Kpi({ label, value, tone, sub }: { label: string; value: string; tone?: 'danger' | 'warn'; sub?: string }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
