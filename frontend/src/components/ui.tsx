'use client';

import { formatUnits } from '@/lib/config';

export function Money({ value, label }: { value?: string; label?: string }) {
  return (
    <span className="mono">
      {value === undefined ? '—' : formatUnits(value)}
      {label ? <span className="muted"> {label}</span> : null}
    </span>
  );
}

export function Progress({ percent, pending }: { percent: number; pending?: boolean }) {
  const width = Math.max(0, Math.min(100, percent));
  return (
    <div
      className="bar"
      role="progressbar"
      aria-valuenow={Math.round(width)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <i className={pending ? 'pending' : ''} style={{ width: `${width}%` }} />
    </div>
  );
}

export function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="small muted">{label}</div>
      <div className="stat">{children}</div>
    </div>
  );
}

/** Percentage of `whole` covered by `part`, both yocto-style decimal strings. */
export function ratio(part?: string, whole?: string): number {
  if (!part || !whole) return 0;
  const denominator = BigInt(whole);
  if (denominator === 0n) return 0;
  return Number((BigInt(part) * 10_000n) / denominator) / 100;
}

export function shortAddress(value: string): string {
  return value.length > 24 ? `${value.slice(0, 15)}…${value.slice(-6)}` : value;
}
