'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

import {
  functionCall,
  getCampaign,
  getCycle,
  getSupporter,
  storageDepositMin,
  tokenBalance,
  tokenStorageBalance,
  type CampaignView,
  type CycleView,
  type SupporterView,
} from '@/lib/api';
import {
  CALL_GAS,
  DEMO_MODE,
  ESCROW_ID,
  ONE_YOCTO,
  formatUnits,
  parseUnits,
  until,
  when,
} from '@/lib/config';
import { demoTokenBalance } from '@/lib/fixtures';
import { useWallet } from '@/lib/wallet';
import { Money, Progress, Stat, ratio, shortAddress } from '@/components/ui';

export default function CampaignPage() {
  const params = useParams<{ id: string }>();
  const campaignId = Number(params.id);

  const { accountId, submit, busy, error, connect } = useWallet();
  const [campaign, setCampaign] = useState<CampaignView | null>(null);
  const [cycle, setCycle] = useState<CycleView | null>(null);
  const [supporter, setSupporter] = useState<SupporterView | null>(null);
  const [backerBalance, setBackerBalance] = useState<string>('0');
  const [amount, setAmount] = useState('25');
  const [notice, setNotice] = useState<string | null>(null);
  // In demo mode the viewer is a fixture backer, so every action control still renders.
  const viewerId = accountId ?? (DEMO_MODE ? 'you.testnet' : null);
  const [failure, setFailure] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!campaignId) return;
    const nextCampaign = await getCampaign(campaignId);
    const nextCycle = await getCycle(campaignId, nextCampaign.current_cycle);
    setCampaign(nextCampaign);
    setCycle(nextCycle);
    if (accountId && !DEMO_MODE) {
      setSupporter(await getSupporter(campaignId, nextCycle.cycle, accountId));
      setBackerBalance(await tokenBalance(accountId));
    } else if (DEMO_MODE) {
      setSupporter(await getSupporter(campaignId, nextCycle.cycle, 'you.testnet'));
      setBackerBalance(demoTokenBalance);
    }
  }, [campaignId, accountId]);

  useEffect(() => {
    refresh().catch((cause: unknown) =>
      setFailure(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [refresh]);

  async function run(label: string, transactions: ReturnType<typeof functionCall>[]) {
    setFailure(null);
    setNotice(null);
    if (DEMO_MODE) {
      setNotice(
        `demo mode: ${label} — ${transactions.length} transaction(s) would be signed and sent on testnet.`,
      );
      return;
    }
    try {
      await submit(transactions);
      setNotice(label);
      await refresh();
    } catch {
      /* provider records `error` */
    }
  }

  async function fund() {
    if (!campaign || !cycle) return;
    if (!DEMO_MODE && !accountId) return;
    let raw: string;
    try {
      raw = parseUnits(amount);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    const transactions: ReturnType<typeof functionCall>[] = [];
    if (accountId) {
      const registered = await tokenStorageBalance(accountId);
      if (!registered) {
        transactions.push(
          functionCall(
            campaign.token,
            'storage_deposit',
            { account_id: null, registration_only: true },
            await storageDepositMin(),
          ),
        );
      }
    }
    transactions.push(
      functionCall(
        campaign.token,
        'ft_transfer_call',
        {
          receiver_id: ESCROW_ID,
          amount: raw,
          memo: null,
          msg: `${campaign.id}:${cycle.cycle}`,
        },
        ONE_YOCTO,
      ),
    );
    await run(`deposit of ${formatUnits(raw)} sent`, transactions);
  }

  if (!campaign || !cycle) {
    return (
      <>
        <h1>Campaign {campaignId}</h1>
        {failure ? <div className="notice error">{failure}</div> : <p className="muted">loading…</p>}
      </>
    );
  }

  const isCreator = viewerId === campaign.creator;
  const depositOpen = !cycle.finalized && Date.now() / 1000 < cycle.contribution_deadline;
  const weight = BigInt(supporter?.deposited ?? '0');
  const canAttest = (index: number) =>
    weight > 0n &&
    cycle.milestones[index].window_open &&
    !supporter?.attested_milestones.includes(index) &&
    !cycle.milestones[index].released;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>{campaign.title}</h1>
        <span className="pill mono">
          #{campaign.id} · cycle {cycle.cycle}
        </span>
      </div>
      <p className="lede">{campaign.summary}</p>
      <p className="small muted">
        creator <span className="mono">{shortAddress(campaign.creator)}</span> · escrow token{' '}
        <span className="mono">{shortAddress(campaign.token)}</span> ·{' '}
        <a href={campaign.reference_url}>{campaign.reference_url}</a> · quorum{' '}
        {(campaign.quorum_bps / 100).toFixed(0)}% of the pool&apos;s money
      </p>

      {(failure || error || notice) && (
        <div className={notice ? 'notice' : 'notice error'}>{notice ?? failure ?? error}</div>
      )}

      <div className="card">
        <div className="grid">
          <Stat label="pool this cycle">
            <Money value={cycle.total_deposited} />
          </Stat>
          <Stat label="released to creator">
            <Money value={cycle.released} />
          </Stat>
          <Stat label="refundable if nothing ships">
            <Money value={cycle.locked} />
          </Stat>
          <Stat label="supporters">{cycle.supporter_count}</Stat>
        </div>
        <div style={{ marginTop: 14 }}>
          <Progress percent={ratio(cycle.released, cycle.total_deposited)} />
          <div className="small muted" style={{ marginTop: 6 }}>
            {cycle.finalized
              ? `cycle finalized ${when(cycle.opens_at)} + windows closed — refunds are claimable`
              : `deposits close ${until(cycle.contribution_deadline)}`}
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Milestones</h2>
        <table>
          <thead>
            <tr>
              <th>milestone</th>
              <th>share</th>
              <th>attested</th>
              <th>quorum</th>
              <th>due</th>
              <th>state</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cycle.milestones.map((milestone) => {
              const attestedPercent = ratio(milestone.attested_weight, cycle.total_deposited);
              const quorumPercent = ratio(milestone.quorum_weight, cycle.total_deposited);
              return (
                <tr key={milestone.index}>
                  <td>
                    {milestone.title}
                    <div className="small muted mono">{formatUnits(milestone.tranche_amount)} units</div>
                  </td>
                  <td className="mono">{(milestone.weight_bps / 100).toFixed(0)}%</td>
                  <td>
                    <div className="mono">{attestedPercent.toFixed(1)}%</div>
                    <div style={{ width: 90, marginTop: 4 }}>
                      <Progress percent={(attestedPercent / Math.max(quorumPercent, 1)) * 100} />
                    </div>
                  </td>
                  <td className="mono">{quorumPercent.toFixed(1)}%</td>
                  <td className="small">{when(milestone.due_at)}</td>
                  <td>
                    {milestone.released ? (
                      <span className="pill good">released</span>
                    ) : milestone.expired ? (
                      <span className="pill bad">refunding</span>
                    ) : milestone.window_open ? (
                      <span className="pill warn">attesting</span>
                    ) : (
                      <span className="pill">not due</span>
                    )}
                  </td>
                  <td className="row" style={{ justifyContent: 'flex-end' }}>
                    {viewerId && canAttest(milestone.index) && (
                      <button
                        className="ghost"
                        disabled={busy}
                        onClick={() =>
                          run(
                            `attested “${milestone.title}” — your ${formatUnits(
                              supporter?.deposited ?? '0',
                            )} now backs it`,
                            [
                              functionCall(ESCROW_ID, 'attest', {
                                campaign_id: campaign.id,
                                cycle: cycle.cycle,
                                index: milestone.index,
                              }),
                            ],
                          )
                        }
                      >
                        attest delivered
                      </button>
                    )}
                    {isCreator && milestone.window_open && !milestone.released && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(`release of ${formatUnits(milestone.tranche_amount)} sent to you`, [
                            functionCall(ESCROW_ID, 'withdraw', {
                              campaign_id: campaign.id,
                              cycle: cycle.cycle,
                              index: milestone.index,
                            }),
                          ])
                        }
                      >
                        claim tranche
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Attestation is only available to accounts that deposited in this cycle, and each account
          counts once with its deposited weight. A tranche releases only when attested weight
          reaches the quorum.
        </p>
      </div>

      <div className="card">
        <h2>Fund this cycle</h2>
        {!viewerId ? (
          <div className="row">
            <button onClick={connect}>Connect to back this campaign</button>
          </div>
        ) : (
          <>
            <div className="row">
              <input
                type="number"
                min={1}
                step="1"
                style={{ maxWidth: 160 }}
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              <button onClick={fund} disabled={busy || !depositOpen}>
                {busy ? 'signing…' : 'back it'}
              </button>
              <span className="pill mono">
                balance {formatUnits(backerBalance)} · your weight{' '}
                {formatUnits(supporter?.deposited ?? '0')}
              </span>
            </div>
            <ul className="ticks">
              <li>one click: your token registration (if needed) and the deposit go out together</li>
              <li>
                {depositOpen
                  ? `deposits accepted until ${when(cycle.contribution_deadline)}`
                  : 'this cycle is closed to new deposits — later transfers bounce back automatically'}
              </li>
            </ul>
          </>
        )}
      </div>

      <div className="card">
        <h2>Cycle close-out</h2>
        <div className="row">
          {!cycle.finalized && (
            <button
              className="ghost"
              disabled={busy || !cycle.can_finalize}
              onClick={() => run('cycle finalized: refund shares locked', [
                functionCall(ESCROW_ID, 'finalize_cycle', {
                  campaign_id: campaign.id,
                  cycle: cycle.cycle,
                }),
              ])}
            >
              finalize cycle
            </button>
          )}
          {cycle.finalized && (
            <button
              disabled={busy || !supporter?.can_refund}
              onClick={() =>
                run(
                  `refund of ${formatUnits(supporter?.refund_share ?? '0')} sent back`,
                  [functionCall(ESCROW_ID, 'refund', { campaign_id: campaign.id, cycle: cycle.cycle })],
                )
              }
            >
              claim my refund
            </button>
          )}
          {cycle.finalized && isCreator && (
            <button
              className="ghost"
              disabled={busy}
              onClick={() => run('next cycle opened', [
                functionCall(ESCROW_ID, 'open_next_cycle', { campaign_id: campaign.id }),
              ])}
            >
              open next cycle
            </button>
          )}
          <span className="small muted">
            {cycle.finalized
              ? `locked ${formatUnits(cycle.locked)} of ${formatUnits(cycle.total_deposited)} is refundable pro-rata`
              : `finalizing opens once every attestation window has closed`}
          </span>
        </div>
        {accountId && supporter && (
          <p className="small muted">
            you deposited {formatUnits(supporter.deposited)} · refund share{' '}
            {formatUnits(supporter.refund_share)} ·{' '}
            {supporter.refunded
              ? 'already claimed'
              : supporter.can_refund
                ? 'claimable now'
                : 'nothing claimable yet'}
            {' · '}
            <Link href="/me">my support</Link>
          </p>
        )}
      </div>
    </>
  );
}
