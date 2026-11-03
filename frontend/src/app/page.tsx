'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { getCampaign, getCycle, listCampaigns, type CampaignView, type CycleView } from '@/lib/api';
import { DEMO_MODE, ESCROW_ID, formatUnits, until } from '@/lib/config';
import { Money, Progress, ratio, shortAddress } from '@/components/ui';

interface Row {
  campaign: CampaignView;
  cycle: CycleView;
}

export default function CampaignsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const ids = DEMO_MODE ? [1] : await listCampaigns();
      const loaded: Row[] = [];
      for (const id of ids) {
        try {
          const campaign = await getCampaign(id);
          const cycle = await getCycle(id, campaign.current_cycle);
          loaded.push({ campaign, cycle });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
      if (!cancelled) {
        setRows(loaded);
        setLoading(false);
      }
    }
    load().catch((cause: unknown) => {
      if (!cancelled) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <h1>Escrowed patronage</h1>
      <p className="lede">
        Supporters fund a creator in cycles. A milestone only pays out once supporters holding a
        quorum of the cycle&apos;s money confirm it was delivered — and whatever goes unconfirmed by
        the deadline stays in the pool and refunds itself pro-rata. No arbiter, no admin key.
      </p>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 18 }}>
        <span className="pill mono">{ESCROW_ID || (DEMO_MODE ? 'demo deployment' : 'not deployed')}</span>
        <Link href="/create" className="pill">
          start a campaign →
        </Link>
      </div>

      {error && <div className="notice error">{error}</div>}
      {loading && <p className="muted">reading the chain…</p>}
      {!loading && rows.length === 0 && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            No campaigns on this deployment yet.{' '}
            <Link href="/create">Start one</Link>.
          </p>
        </div>
      )}

      {rows.map(({ campaign, cycle }) => {
        const released = ratio(cycle.released, cycle.total_deposited);
        return (
          <Link key={campaign.id} href={`/campaign/${campaign.id}`} style={{ color: 'inherit' }}>
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h2 style={{ margin: 0 }}>{campaign.title}</h2>
                <span className={cycle.finalized ? 'pill' : 'pill good'}>
                  cycle {cycle.cycle} {cycle.finalized ? 'finalized' : 'open'}
                </span>
              </div>
              <p className="muted small" style={{ margin: '6px 0 12px' }}>
                {campaign.summary}
              </p>
              <div className="grid">
                <div>
                  <div className="small muted">pool</div>
                  <div className="stat">
                    <Money value={cycle.total_deposited} />
                  </div>
                </div>
                <div>
                  <div className="small muted">supporters</div>
                  <div className="stat">{cycle.supporter_count}</div>
                </div>
                <div>
                  <div className="small muted">refundable now</div>
                  <div className="stat">
                    <Money value={cycle.locked} />
                  </div>
                </div>
                <div>
                  <div className="small muted">deposits close</div>
                  <div className="stat">{until(cycle.contribution_deadline)}</div>
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <Progress percent={released} />
                <div className="small muted" style={{ marginTop: 6 }}>
                  {released.toFixed(1)}% released to{' '}
                  <span className="mono">{shortAddress(campaign.creator)}</span> ·{' '}
                  {campaign.milestones.length} milestones · quorum{' '}
                  {(campaign.quorum_bps / 100).toFixed(0)}% of money
                </div>
              </div>
            </div>
          </Link>
        );
      })}

      <p className="small muted">
        Amounts are in the campaign&apos;s stable unit ({formatUnits('1000000')} = one unit).
      </p>
    </>
  );
}
