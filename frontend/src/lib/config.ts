export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? 'https://rpc.testnet.near.org';
export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? 'testnet') as
  | 'mainnet'
  | 'testnet';

/** Deployed Patron escrow. Empty in demo mode, where screens render fixtures instead. */
export const ESCROW_ID = process.env.NEXT_PUBLIC_ESCROW_ID ?? '';
export const TOKEN_ID = process.env.NEXT_PUBLIC_TOKEN_ID ?? '';
export const TOKEN_DECIMALS = Number(process.env.NEXT_PUBLIC_TOKEN_DECIMALS ?? 6);

/**
 * Read-only against bundled fixtures. Forced when no escrow is configured, so `pnpm dev` with an
 * empty environment still shows populated screens instead of an error.
 */
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true' || !ESCROW_ID;

export const CALL_GAS = '100000000000000'; // 100 TGas
export const ONE_YOCTO = '1';

export function formatUnits(raw: string | number | undefined): string {
  if (raw === undefined) return '—';
  const value = BigInt(raw);
  const base = 10n ** BigInt(TOKEN_DECIMALS);
  const whole = value / base;
  const frac = (value % base).toString().padStart(TOKEN_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function parseUnits(human: string): string {
  const cleaned = human.replace(/[, _]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) throw new Error('enter a positive amount');
  const [whole, frac = ''] = cleaned.split('.');
  const padded = (frac + '0'.repeat(TOKEN_DECIMALS)).slice(0, TOKEN_DECIMALS);
  return (BigInt(whole) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt(padded || 0)).toString();
}

export const bps = (value: number) => `${(value / 100).toFixed(value % 100 ? 1 : 0)}%`;

export function when(unixSec: number): string {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function until(unixSec: number): string {
  if (!unixSec) return '—';
  const seconds = unixSec - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return 'closed';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${mins}m`;
  return `${mins}m ${seconds % 60}s`;
}
