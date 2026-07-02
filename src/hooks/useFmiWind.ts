import { useEffect, useState } from 'react';

export interface FmiWind {
  speed_ms: number | null;
  gust_ms: number | null;
  dir_deg: number | null;
  place: string;
  updatedAt: string | null;
}

/**
 * Live current-conditions wind from the FMI open-data WFS (real, decoupled from
 * the replayed storm). Best-effort: returns null on CORS/parse failure so the
 * UI falls back to the scenario's synthetic wind.
 */
export function useFmiWind(place: string, refreshMs = 300_000): FmiWind | null {
  const [wind, setWind] = useState<FmiWind | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url =
      'https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=getFeature' +
      '&storedquery_id=fmi::observations::weather::simple' +
      `&place=${encodeURIComponent(place)}` +
      '&parameters=ws_10min,wg_10min,wd_10min&maxlocations=1';

    async function load() {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const text = await res.text();
        const doc = new DOMParser().parseFromString(text, 'text/xml');
        const els = Array.from(doc.getElementsByTagName('BsWfs:BsWfsElement'));
        const latest: Record<string, { v: number; t: string }> = {};
        for (const el of els) {
          const name = el.getElementsByTagName('BsWfs:ParameterName')[0]?.textContent ?? '';
          const val = parseFloat(el.getElementsByTagName('BsWfs:ParameterValue')[0]?.textContent ?? 'NaN');
          const time = el.getElementsByTagName('BsWfs:Time')[0]?.textContent ?? '';
          if (!Number.isNaN(val) && (!latest[name] || time > latest[name].t)) {
            latest[name] = { v: val, t: time };
          }
        }
        if (cancelled) return;
        if (!latest.ws_10min && !latest.wg_10min) {
          setWind(null);
          return;
        }
        setWind({
          speed_ms: latest.ws_10min?.v ?? null,
          gust_ms: latest.wg_10min?.v ?? null,
          dir_deg: latest.wd_10min?.v ?? null,
          place,
          updatedAt: latest.ws_10min?.t ?? null,
        });
      } catch {
        if (!cancelled) setWind(null);
      }
    }

    load();
    const id = setInterval(load, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [place, refreshMs]);

  return wind;
}
