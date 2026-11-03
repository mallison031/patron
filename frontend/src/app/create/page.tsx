'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { functionCall } from '@/lib/api';
import { CALL_GAS, ESCROW_ID, TOKEN_ID } from '@/lib/config';
import { useWallet } from '@/lib/wallet';

interface MilestoneDraft {
  title: string;
  weight_bps: number;
  due_offset_sec: number;
}

const DAY = 86_400;

function emptyMilestones(): MilestoneDraft[] {
  return [
    { title: 'issues 1-4', weight_bps: 5000, due_offset_sec: 30 * DAY },
    { title: 'issues 5-8', weight_bps: 5000, due_offset_sec: 60 * DAY },
  ];
}

export default function CreatePage() {
  const router = useRouter();
  const { accountId, submit, busy, error, connect } = useWallet();

  const [title, setTitle] = useState('Rust zine: eight issues');
  const [summary, setSummary] = useState(
    'One issue a month. Half the pool releases after issue 4, half after issue 8.',
  );
  const [reference, setReference] = useState('https://example.com/rust-zine');
  const [token, setToken] = useState(TOKEN_ID);
  const [contributionDays, setContributionDays] = useState(14);
  const [attestationDays, setAttestationDays] = useState(10);
  const [quorumPercent, setQuorumPercent] = useState(50);
  const [milestones, setMilestones] = useState<MilestoneDraft[]>(emptyMilestones());
  const [localError, setLocalError] = useState<string | null>(null);
  const [created, setCreated] = useState<number | null>(null);

  const weightSum = milestones.reduce((total, item) => total + item.weight_bps, 0);
  const firstDue = Math.min(...milestones.map((item) => item.due_offset_sec));

  function update(index: number, patch: Partial<MilestoneDraft>) {
    setMilestones((all) => all.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  async function create() {
    setLocalError(null);
    if (!ESCROW_ID) return setLocalError('no escrow contract configured');
    if (weightSum !== 10_000) {
      return setLocalError(`milestone weights must sum to 10000 bps, currently ${weightSum}`);
    }
    if (contributionDays * DAY > firstDue) {
      return setLocalError('deposits must close before the first milestone is due');
    }
    const transactions = [
      functionCall(
        ESCROW_ID,
        'create_campaign',
        {
          creator: accountId,
          title,
          summary,
          reference_url: reference,
          token,
          milestones,
          contribution_window_sec: contributionDays * DAY,
          attestation_window_sec: attestationDays * DAY,
          quorum_bps: Math.round(quorumPercent * 100),
        },
        '0',
        CALL_GAS,
      ),
    ];
    try {
      await submit(transactions);
      setCreated(1);
      router.push('/?created=1');
    } catch {
      /* surfaced through `error` from the wallet provider */
    }
  }

  return (
    <>
      <h1>Start a campaign</h1>
      <p className="lede">
        You propose the milestones and their share of the pool. Supporters decide whether you
        delivered: a milestone releases only when supporters of at least <em>quorum</em> of the pool
        attest it, and an unattested milestone&apos;s share returns to the pool.
      </p>

      {!accountId && (
        <div className="notice">
          Connect a wallet to create a campaign. <button onClick={connect}>Connect</button>
        </div>
      )}

      <div className="card">
        <label>title</label>
        <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />

        <label>summary</label>
        <textarea
          rows={3}
          maxLength={500}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
        />

        <label>where the work is visible</label>
        <input value={reference} onChange={(event) => setReference(event.target.value)} />

        <label>escrow token (NEP-141 account)</label>
        <input value={token} onChange={(event) => setToken(event.target.value)} />

        <div className="grid">
          <div>
            <label>days to deposit</label>
            <input
              type="number"
              min={1}
              value={contributionDays}
              onChange={(event) => setContributionDays(Number(event.target.value))}
            />
          </div>
          <div>
            <label>days to attest after due</label>
            <input
              type="number"
              min={1}
              value={attestationDays}
              onChange={(event) => setAttestationDays(Number(event.target.value))}
            />
          </div>
          <div>
            <label>quorum, % of pool</label>
            <input
              type="number"
              min={1}
              max={100}
              value={quorumPercent}
              onChange={(event) => setQuorumPercent(Number(event.target.value))}
            />
          </div>
        </div>
      </div>

      <fieldset>
        <legend>
          milestones — {weightSum.toLocaleString()} / 10,000 bps
        </legend>
        {milestones.map((milestone, index) => (
          <div className="grid" key={index} style={{ alignItems: 'end' }}>
            <div>
              <label>title</label>
              <input
                value={milestone.title}
                maxLength={120}
                onChange={(event) => update(index, { title: event.target.value })}
              />
            </div>
            <div>
              <label>share (bps)</label>
              <input
                type="number"
                min={1}
                max={10_000}
                value={milestone.weight_bps}
                onChange={(event) => update(index, { weight_bps: Number(event.target.value) })}
              />
            </div>
            <div>
              <label>due in seconds</label>
              <input
                type="number"
                min={1}
                value={milestone.due_offset_sec}
                onChange={(event) => update(index, { due_offset_sec: Number(event.target.value) })}
              />
            </div>
            <button
              className="ghost"
              onClick={() => setMilestones((all) => all.filter((_, i) => i !== index))}
              disabled={milestones.length < 2}
            >
              remove
            </button>
          </div>
        ))}
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="ghost"
            onClick={() =>
              setMilestones((all) => [
                ...all,
                { title: `milestone ${all.length + 1}`, weight_bps: 0, due_offset_sec: 30 * DAY },
              ])
            }
          >
            add milestone
          </button>
          {weightSum !== 10_000 && (
            <button
              className="ghost"
              onClick={() => {
                const even = Math.floor(10_000 / milestones.length);
                const rest = 10_000 - even * milestones.length;
                setMilestones((all) =>
                  all.map((item, i) => ({ ...item, weight_bps: even + (i === 0 ? rest : 0) })),
                );
              }}
            >
              split evenly
            </button>
          )}
        </div>
      </fieldset>

      {(localError || error) && <div className="notice error">{localError ?? error}</div>}

      <div className="row">
        <button onClick={create} disabled={!accountId || busy || weightSum !== 10_000}>
          {busy ? 'signing…' : 'create campaign'}
        </button>
        <span className="small muted">
          creating costs gas and registers the escrow on the token; cycle 1 opens immediately.
        </span>
      </div>
      {created !== null && <div className="notice">campaign created</div>}
    </>
  );
}
