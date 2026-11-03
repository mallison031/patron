import type { CampaignView, CycleView, SupporterView } from './api';

/**
 * Sample state for `NEXT_PUBLIC_DEMO_MODE=true`, so the four screens can be reviewed without a
 * wallet or RPC endpoint. Values mirror what the contract's views return on testnet.
 */
const now = Math.floor(Date.now() / 1000);
const day = 86_400;

export const demoCampaign: CampaignView = {
  id: 1,
  creator: 'zine-maker.testnet',
  title: 'Rust zine: eight issues',
  summary:
    'One issue a month for eight months. Half the pool releases after issue 4, half after issue 8. ' +
    'Any half nobody attests goes straight back to the people who funded it.',
  reference_url: 'https://example.com/rust-zine',
  token: 'pusd.demo.testnet',
  milestones: [
    { title: 'issues 1-4', weight_bps: 5000, due_offset_sec: 30 * day },
    { title: 'issues 5-8', weight_bps: 5000, due_offset_sec: 60 * day },
  ],
  contribution_window_sec: 14 * day,
  attestation_window_sec: 10 * day,
  quorum_bps: 5000,
  current_cycle: 1,
  created_at: now - 4 * day,
  token_registered: true,
};

export const demoCycle: CycleView = {
  campaign_id: 1,
  cycle: 1,
  opens_at: now - 4 * day,
  contribution_deadline: now + 10 * day,
  total_deposited: '100000000',
  released: '0',
  locked: '100000000',
  supporter_count: 2,
  finalized: false,
  can_finalize: false,
  milestones: [
    {
      index: 0,
      title: 'issues 1-4',
      weight_bps: 5000,
      due_at: now + 26 * day,
      attestation_deadline: now + 36 * day,
      attested_weight: '60000000',
      quorum_weight: '50000000',
      tranche_amount: '50000000',
      released: false,
      window_open: false,
      expired: false,
    },
    {
      index: 1,
      title: 'issues 5-8',
      weight_bps: 5000,
      due_at: now + 56 * day,
      attestation_deadline: now + 66 * day,
      attested_weight: '0',
      quorum_weight: '50000000',
      tranche_amount: '50000000',
      released: false,
      window_open: false,
      expired: false,
    },
  ],
};

/** What the viewer's wallet holds on the demo token, in raw units. */
export const demoTokenBalance = '400000000';

export const demoSupporters: SupporterView = {
  supporter: 'you.testnet',
  cycle: 1,
  deposited: '60000000',
  refund_share: '0',
  refunded: false,
  attested_milestones: [0],
  can_refund: false,
};
