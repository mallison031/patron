'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  functionCall,
  getCampaign,
  getCycle,
  getSupporter,
  listCampaigns,
  type SupporterView,
} from '@/lib/api';
import { DEMO_MODE, ESCROW_ID, formatUnits } from '@/lib/config';
import { demoSupporters } from '@/lib/fixtures';
import { useWallet } from '@/lib/wallet';
import { shortAddress } from '@/components/ui';

interface Entry {
  campaignId: number;
  title: string;
  cycle: number;
  supporter: SupporterView;
}

export default function MySupportPage() {
  const { accountId, submit, busy, error, connect } = useWallet();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (DEMO_MODE) {
      setEntries([
        {
          campaignId: 1,
          title: 'Rust zine: eight issues',
          cycle: demoSupporters.cycle,
          supporter: demoSupporters,
        },
      ]);
      return;
    }
    if (!accountId || !ESCROW_ID) return;
    let cancelled = false;
    setLoading(true);
    async function load() {
      const found: Entry[] = [];
      for (const campaignId of await listCampaigns()) {
        try {
          const campaign = await getCampaign(campaignId);
          for (let cycle = 1; cycle <= campaign.current_cycle; cycle += 1) {
            const supporter = await getSupporter(campaignId, cycle, accountId!);
            if (BigInt(supporter.deposited) > 0n) {
              found.push({ campaignId, title: campaign.title, cycle, supporter });
            }
          }
        } catch {
          /* a campaign whose cycle view is missing simply does not list */
        }
      }
      if (!cancelled) {
        setEntries(found);
        setLoading(false);
      }
    }
    load().catch((cause: unknown) => {
      setFailure(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  async function claim(entry: Entry) {
    setFailure(null);
    setNotice(null);
    try {
      await submit([
        functionCall(ESCROW_ID, 'refund', {
          campaign_id: entry.campaignId,
          cycle: entry.cycle,
        }),
      ]);
      setNotice(
        `claimed ${formatUnits(entry.supporter.refund_share)} from “${entry.title}” cycle ${entry.cycle}`,
      );
    } catch {
      /* provider records `error` */
    }
  }

  const deposited = entries.reduce((total, entry) => total + BigInt(entry.supporter.deposited), 0n);
  const claimable = entries
    .filter((entry) => entry.supporter.can_refund)
    .reduce((total, entry) => total + BigInt(entry.supporter.refund_share), 0n);
  const attested = new Set(
    entries.flatMap((entry) => entry.supporter.attested_milestones.map((i) => `${entry.campaignId}:${entry.cycle}:${i}`)),
  );

  return (
    <>
      <h1>My support</h1>
      <p className="lede">
        Every deposit you made is your voting weight for that cycle, and every cycle refunds you
        your share of what supporters did not confirm.
      </p>

      {!accountId && !DEMO_MODE && (
        <div className="notice">
          Connect a wallet to see your deposits. <button onClick={connect}>Connect</button>
        </div>
      )}
      {(failure || error || notice) && (
        <div className={notice ? 'notice' : 'notice error'}>{notice ?? failure ?? error}</div>
      )}

      <div className="card tight row" style={{ justifyContent: 'space-between' }}>
        <span className="small muted">
          deposited <span className="mono">{formatUnits(deposited.toString())}</span> · claimable{' '}
          <span className="mono">{formatUnits(claimable.toString())}</span> · attestations{' '}
          {attested.size}
        </span>
        {loading && <span className="pill">reading chain…</span>}
      </div>

      {accountId || DEMO_MODE ? (
        <div className="card">
          {entries.length === 0 && !loading ? (
            <p className="muted" style={{ margin: 0 }}>
              Nothing backed yet. <Link href="/">find a campaign</Link>.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>campaign</th>
                  <th>cycle</th>
                  <th>your deposit</th>
                  <th>refund share</th>
                  <th>attested</th>
                  <th>state</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={`${entry.campaignId}:${entry.cycle}`}>
                    <td>
                      <Link href={`/campaign/${entry.campaignId}`}>{entry.title}</Link>
                      <div className="small muted mono">{shortAddress(ESCROW_ID)}</div>
                    </td>
                    <td className="mono">{entry.cycle}</td>
                    <td className="mono">{formatUnits(entry.supporter.deposited)}</td>
                    <td className="mono">{formatUnits(entry.supporter.refund_share)}</td>
                    <td className="mono">
                      {entry.supporter.attested_milestones.join(', ') || '—'}
                    </td>
                    <td>
                      {entry.supporter.refunded ? (
                        <span className="pill">claimed</span>
                      ) : entry.supporter.can_refund ? (
                        <span className="pill warn">refund ready</span>
                      ) : entry.supporter.deposited !== '0' && !entry.supporter.can_refund ? (
                        <span className="pill">in escrow</span>
                      ) : (
                        <span className="pill">—</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {entry.supporter.can_refund && (
                        <button disabled={busy} onClick={() => claim(entry)}>
                          claim refund
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </>
  );
}
