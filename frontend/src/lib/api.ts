import { actionCreators } from '@near-js/transactions';

import { CALL_GAS, DEMO_MODE, ESCROW_ID, RPC_URL, TOKEN_ID } from './config';
import { demoCampaign, demoCycle, demoSupporters } from './fixtures';

export interface MilestoneSpec {
  title: string;
  weight_bps: number;
  due_offset_sec: number;
}

export interface CampaignView {
  id: number;
  creator: string;
  title: string;
  summary: string;
  reference_url: string;
  token: string;
  milestones: MilestoneSpec[];
  contribution_window_sec: number;
  attestation_window_sec: number;
  quorum_bps: number;
  current_cycle: number;
  created_at: number;
  token_registered: boolean;
}

export interface MilestoneStatus {
  index: number;
  title: string;
  weight_bps: number;
  due_at: number;
  attestation_deadline: number;
  attested_weight: string;
  quorum_weight: string;
  tranche_amount: string;
  released: boolean;
  window_open: boolean;
  expired: boolean;
}

export interface CycleView {
  campaign_id: number;
  cycle: number;
  opens_at: number;
  contribution_deadline: number;
  total_deposited: string;
  released: string;
  locked: string;
  supporter_count: number;
  finalized: boolean;
  can_finalize: boolean;
  milestones: MilestoneStatus[];
}

export interface SupporterView {
  supporter: string;
  cycle: number;
  deposited: string;
  refund_share: string;
  refunded: boolean;
  attested_milestones: number[];
  can_refund: boolean;
}

function encodeArgs(args: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeResult(result: string | number[]): string {
  const bytes =
    typeof result === 'string'
      ? Uint8Array.from(atob(result), (char) => char.charCodeAt(0))
      : Uint8Array.from(result);
  return new TextDecoder().decode(bytes);
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'patron', method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message ?? 'RPC error');
  return body.result as T;
}

/**
 * Read-only contract call. Uses `query`/`call_function`: the legacy `call` method is not served
 * by every RPC, and answers 404 with METHOD_NOT_FOUND. `result` comes back as the wasm's raw JSON
 * bytes, either an array of byte values or base64 depending on the node.
 */
export async function view<T>(contractId: string, method: string, args: object): Promise<T> {
  const result = await rpc<{ result: string | number[] }>('query', {
    request_type: 'call_function',
    account_id: contractId,
    method_name: method,
    args_base64: encodeArgs(args),
    finality: 'optimistic',
  });
  return JSON.parse(decodeResult(result.result)) as T;
}

export async function listCampaigns(): Promise<number[]> {
  if (!ESCROW_ID) return [];
  return view<number[]>(ESCROW_ID, 'list_campaigns', { from: null, limit: 25 });
}

export async function getCampaign(id: number): Promise<CampaignView> {
  if (DEMO_MODE) return { ...demoCampaign, id };
  return view<CampaignView>(ESCROW_ID, 'get_campaign', { campaign_id: id });
}

export async function getCycle(id: number, cycle: number): Promise<CycleView> {
  if (DEMO_MODE) return { ...demoCycle, campaign_id: id, cycle };
  return view<CycleView>(ESCROW_ID, 'get_cycle', { campaign_id: id, cycle });
}

export async function getSupporter(
  id: number,
  cycle: number,
  supporter: string,
): Promise<SupporterView> {
  if (DEMO_MODE) {
    return { ...demoSupporters, cycle, supporter };
  }
  return view<SupporterView>(ESCROW_ID, 'get_supporter', {
    campaign_id: id,
    cycle,
    supporter,
  });
}

export async function tokenBalance(accountId: string): Promise<string> {
  if (!TOKEN_ID) return '0';
  const { amount } = await view<{ amount: string }>(TOKEN_ID, 'ft_balance_of', {
    account_id: accountId,
  });
  return amount;
}

/** Minimum Ⓝ a backer must lock to hold a balance on the escrow token. */
export async function storageDepositMin(): Promise<string> {
  if (!TOKEN_ID) return '0';
  const { min } = await view<{ min: string; max: string | null }>(
    TOKEN_ID,
    'storage_balance_bounds',
    {},
  );
  return min;
}

export async function tokenStorageBalance(accountId: string): Promise<string | null> {
  if (!TOKEN_ID) return null;
  const balance = await view<{ total: string; available: string } | null>(
    TOKEN_ID,
    'storage_balance_of',
    { account_id: accountId },
  );
  return balance?.total ?? null;
}

export function functionCall(
  receiverId: string,
  methodName: string,
  args: object,
  deposit = '0',
  gas = CALL_GAS,
) {
  return {
    receiverId,
    actions: [actionCreators.functionCall(methodName, args, BigInt(gas), BigInt(deposit))],
  };
}

export type PatronTransaction = ReturnType<typeof functionCall>;

export type CallArgs = Record<string, unknown>;
