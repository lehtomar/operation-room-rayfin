import type { Scenario, Wind } from '../lib/types';
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
  wind: Wind | null; // scenario / storm wind
  fmiWind: FmiWind | null; // live FMI wind
  mode: 'storm' | 'live';
  onMode: (m: 'storm' | 'live') => void;
}

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
  const live = props.mode === 'live';
  const stormActive = kpis.activeFaults > 0;

  // one wind chip — scenario wind in replay, live FMI wind in live mode
  const wSpeed = live ? fmiWind?.speed_ms ?? null : wind?.speed_ms ?? null;
  const wGust = live ? fmiWind?.gust_ms ?? null : wind?.gust_ms ?? null;
  const wDir = live ? fmiWind?.dir_deg ?? null : wind?.dir_deg ?? null;
  const clockIso = live ? new Date().toISOString() : scenario?.sim_clock ?? undefined;

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-title">VERKKOVAHTI</div>
        <div className="brand-sub">GRID OPERATIONS · DSO</div>
      </div>

      <div className="viewmode">
        <button className={`vm-btn ${!live ? 'active' : ''}`} onClick={() => props.onMode('storm')}>
          Storm replay
        </button>
        <button className={`vm-btn ${live ? 'active' : ''}`} onClick={() => props.onMode('live')}>
          Live
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
        <div className="wind-chip" title={live ? 'FMI live wind' : 'Storm wind'}>
          <span className="wind-lbl">WIND</span>
          {wDir != null && (
            <span className="wind-arrow" style={{ transform: `rotate(${wDir + 180}deg)` }}>↑</span>
          )}
          <span className="wind-val">{wSpeed != null ? wSpeed.toFixed(0) : '–'}</span>
          <span className="wind-unit">m/s</span>
          {wGust != null && <span className="wind-gust">gust {wGust.toFixed(0)}</span>}
          {live && <span className="fmi-tag">FMI</span>}
        </div>
        {stormActive ? (
          <div className="badge major badge-live">
            <span className="dot" /> MAJOR DISTURBANCE
          </div>
        ) : (
          <div className="badge badge-ok">
            <span className="dot" /> {live ? 'LIVE' : 'NORMAL'}
          </div>
        )}
      </div>

      <div className="clockbox">
        <span className="conn-dot ok" title="Live (in-browser engine)" />
        <div>
          <div className="sim-time">{clock(clockIso)}</div>
          <div className="sim-date">{dateStr(clockIso)}</div>
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
