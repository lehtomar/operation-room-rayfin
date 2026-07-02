import type { AlertItem } from '../lib/events';

interface EventsTickerProps {
  alerts: AlertItem[];
}

export function EventsTicker({ alerts }: EventsTickerProps) {
  const recent = alerts.slice(0, 12);
  return (
    <div className="ticker">
      <span className="ticker-tag">● EVENTS</span>
      <div className="ticker-items">
        {recent.length === 0 && <span className="ticker-item">—</span>}
        {recent.map((a, idx) => (
          <span key={idx} className={`ticker-item tk-${a.kind}`}>
            {a.text}
          </span>
        ))}
      </div>
    </div>
  );
}
