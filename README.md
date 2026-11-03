# Patron — escrowed patronage on NEAR

**Supporters fund a creator in cycles. Each milestone pays out only when supporters holding a
quorum of *the cycle's money* confirm it shipped. Whatever is unconfirmed when the window closes
stays in the pool and refunds itself, pro-rata. No arbiter, no admin key, no refund request form.**

NEAR Hackathon 2026 · track: **Social Money**.

---

## Proof it works (start here)

| Claim | Check it yourself |
| --- | --- |
| A real cycle ran on testnet: 240 PUSD in, 96 released against a quorum, 144 refunded | `python3 scripts/view.py patron-escrow-hackathon.testnet get_cycle '{"campaign_id":1,"cycle":1}'` |
| Money actually moved to the creator and back to each backer | every step is a signed testnet transaction on [explorer](https://explorer.testnet.near.org/account/patron-escrow-hackathon.testnet) — the contract logs name them: `… refunded 60000000 for campaign 1 cycle 1` |
| Refunding twice is impossible | `Smart contract panicked: already refunded this cycle` (also asserted in the sandbox suite) |
| The escrow never keeps settled money | `python3 scripts/view.py patron-pusd-hackathon.testnet ft_balance_of '{"account_id":"patron-escrow-hackathon.testnet"}'` — it holds exactly what is still escrowed for open cycles, and `locked` in `get_cycle` says how much of that is refundable |
| The UI reads that same chain state | `cd frontend && npm run dev`, open `/campaign/1` with the two account IDs in `.env.local` |
| Every rule above is machine-checked | `cargo test --manifest-path contract/Cargo.toml` → 9 passing sandbox tests |

Live contracts (testnet):

- escrow — `patron-escrow-hackathon.testnet`
- stable unit — `patron-pusd-hackathon.testnet` (NEP-141, 6 decimals, "PUSD" demo asset)
- campaigns 1, 3 and 4 = completed repro runs — funded, one tranche released against a quorum, the
  rest refunded pro-rata
- campaign 5 = **open for backing until 6 Nov 2026 14:19 UTC** — same contract, windows in days, so
  you can drive it from the app (ask on X for demo PUSD)

The first four rows need nothing but `python3` and a network connection — they are read-only
JSON-RPC calls, no wallet, no install, no signing.

## The problem this solves

Patreon-style patronage pays *before* delivery and takes the money back only if the creator
voluntarily agrees. Independent creators who ship irregularly — a newsletter, a beat, a plugin, an
EP — carry all the trust risk in one direction, and the platform settles disputes with a support
ticket. Grants and bounties fix the direction but invert the risk: the funder must pre-fund, then
monitor, then decide, and the maker must trust that decision.

Patron inverts the escrow: the people who paid are the ones who release the money, one milestone at
a time, on a deadline that the campaign sets up front. If they do nothing, the default outcome is a
refund, not a stalemate.

## How a cycle works

```
 open ──► contribution window (45s … months) ──► milestone due ──► attestation window ──► finalize
            ft_transfer_call                        attest / withdraw                       │
            (auto-refunds the unused               (creator releases a tranche             ▼
             part, per NEP-141)                     only on a money-weighted quorum)   refund()
```

1. **`create_campaign`** — creator names milestones, each with a share of the pool (`weight_bps`,
   must sum to 10 000), a `due_offset_sec`, a contribution window, an attestation window and a
   quorum in bps. The contract registers itself for storage on the token here, so the very first
   backer's `ft_transfer_call` cannot bounce.
2. **Fund** — a backer sends NEP-141 tokens with `ft_transfer_call` and `msg = "<campaign>:<cycle>"`.
   `ft_on_transfer` credits the deposit and returns any unused amount, so over-sending self-refunds.
   Deposits close on the deadline; the pool for a cycle is fixed after that.
3. **Attest** — after a milestone is due, any backer of *that cycle* votes once. Voting weight is
   what that backer deposited, so the quorum is a quorum of money, not of accounts (one account,
   one vote, weighted — Sybil cost is the deposit itself).
4. **`withdraw`** — the creator pulls one tranche, and only once `attested_weight ≥ quorum`.
   Outside the attestation window the call reverts: *"attestation window closed; this milestone is
   permanently refundable"*.
5. **`finalize_cycle`** — anyone can call it after the last attestation window closes. It snapshots
   `total` and `locked`, so refund shares cannot drift as people claim.
6. **`refund`** — each backer claims `deposited × locked / total`. Marked once per (campaign, cycle,
   backer). A cycle that delivered everything raises *"nothing to refund: this cycle delivered in
   full"* rather than silently consuming the marker.
7. **`open_next_cycle`** — recurring patronage is the same cycle, again. Each cycle refunds
   independently, so a bad month never freezes a good one.

## Guards

| Invariant | Enforced in | Sandbox test |
| --- | --- | --- |
| Milestone weights sum to exactly 10 000 bps; the first milestone is due after deposits close; sane windows | `create_campaign` | `campaign_validation_is_enforced_at_creation` |
| Late or over-sized deposits return to the sender instead of vanishing | `ft_on_transfer` | `late_or_malformed_deposits_are_returned_to_the_backer` |
| Only that cycle's backers vote, once each, weighted by what they deposited; a 40% vote does not satisfy a 50% quorum | `attest`, `withdraw` | `release_requires_a_supporter_quorum_then_pays_the_creator` |
| Nothing releases before the milestone is due | `attest`, `withdraw` | `release_is_refused_before_the_milestone_is_due` |
| Refund share is frozen at finalize, splits pro-rata, and can be claimed once per cycle | `finalize_cycle`, `refund` | `undelivered_milestone_refunds_supporters_pro_rata` |
| A cycle that delivered everything has nothing to refund, and does not consume the claim marker | `refund` | `fully_delivered_cycle_refunds_nothing` |
| A failed payout rolls back instead of burning supporter money | `on_release_result` / `on_refund_result` (`#[private]`) | `failed_payout_rolls_back_instead_of_burning_supporter_money` |
| New cycles start empty; one bad cycle cannot freeze a good one | `open_next_cycle` | `recurring_cycles_start_empty_and_refund_independently` |
| `ft_transfer` carries the mandatory exactly-1-yocto deposit | `withdraw`, `refund` | a real NEP-141 token rejects the call without it — only the sandbox tests can catch this |
| No owner, no pause, no upgrade key, no privileged withdrawal | the contract has no such field | read `contract/src/lib.rs` |

## Run it

### Read the deployed state

```bash
python3 scripts/view.py patron-escrow-hackathon.testnet list_campaigns '{"from":null,"limit":10}'
python3 scripts/view.py patron-escrow-hackathon.testnet get_cycle '{"campaign_id":1,"cycle":1}'
python3 scripts/view.py patron-escrow-hackathon.testnet get_supporter \
  '{"campaign_id":1,"cycle":1,"supporter":"alice.patrondemo.testnet"}'
```

`view.py` is ~40 lines of `urllib` against `query`/`call_function`; no SDK, no install.

### Run the sandbox suite (9 tests, ~60s)

```bash
rustup target add wasm32-unknown-unknown              # once
cargo near build non-reproducible-wasm --manifest-path contract/Cargo.toml --out-dir artifacts
cargo near build non-reproducible-wasm --manifest-path token/Cargo.toml --out-dir artifacts
cargo test --manifest-path contract/Cargo.toml
```

Tests run a real NEAR sandbox (`near-workspaces`) with the compiled wasm, fast-forward the chain
clock, and assert on token balances — not on mocked state. The artifacts must be rebuilt after a
contract edit, otherwise the tests run the previous binary.

### Reproduce a refund on testnet end to end

```bash
bash scripts/repro-refund.sh
```

Creates a campaign, takes three backer deposits, reaches a quorum on the milestone that "ships",
lets the second one lapse, finalizes, and claims all three refunds — printing the explorer link for
every step and the token balance before and after each claim. About 3½ minutes, mostly waiting on
the attestation windows. Override `ESCROW`, `TOKEN`, `CREATOR` and `BACKERS` to use your own
accounts (each needs a near-cli keychain key, ~1.25 NEAR for the token storage deposit, and PUSD;
ask on X for demo PUSD and I will send some).

<details>
<summary>Reference run — campaign 4, every step a signed testnet transaction</summary>

| step | transaction | on-chain effect |
| --- | --- | --- |
| `create_campaign` | [3BUrKPoj…](https://explorer.testnet.near.org/transactions/3BUrKPojF7rSV7KGM5bXadSSWTg4L88t5UnJw6PF6S5Y) | campaign 4, cycle 1 opens |
| 3 × `ft_transfer_call` | [HQ2wdTq8…](https://explorer.testnet.near.org/transactions/HQ2wdTq8wScPkbxfj22E6vkfSCRJGDByMZ6T9444m7mB) · [33KEfEuq…](https://explorer.testnet.near.org/transactions/33KEfEuqsucebu7W43E6QxVqdNAGAaN8E6BCoprgjpHx) · [2utpPAAw…](https://explorer.testnet.near.org/transactions/2utpPAAwmjjFcnoG4NRi7oNTdgaQKSf7dNWESqg9v8Px) | pool = 240 PUSD, quorum = 120 |
| 3 × `attest` | [Bxg9oehy…](https://explorer.testnet.near.org/transactions/Bxg9oehyiDkaQod4ReVoFhmjK83aQo1V1iNLgLCt7uSK) · [GokBcN4x…](https://explorer.testnet.near.org/transactions/GokBcN4xhTd7a4JEUYTJGeGmKBuZhYt8yv8djZ9waV4Z) · [FoYGEMAT…](https://explorer.testnet.near.org/transactions/FoYGEMATVjuqwy2kQ9D1aAeqxfFoMQAXh54WNzcPmsGv) | attested weight 240 ≥ 120 |
| `withdraw` | [4NJ4a5dr…](https://explorer.testnet.near.org/transactions/4NJ4a5drcHFrxgj7n2XEvcsMM8C1AR4eCfrBD2YgKXfx) | creator 997 792 → 997 888 PUSD (+96) |
| `finalize_cycle` | [4eD7jZpU…](https://explorer.testnet.near.org/transactions/4eD7jZpUJ3VUaYGPfj7F4xRPiL521b6Tmnb2KQBfySip) | locked 144 of 240 |
| `refund` ×3 | [2eovkfWH…](https://explorer.testnet.near.org/transactions/2eovkfWHtG8u8EWN7XEjh9JRBkG1wNvsd6ut5sUChtRB) · [BaJSYCXE…](https://explorer.testnet.near.org/transactions/BaJSYCXEQxthih44Rd6wmx8GG1e3gCCePEFuTZCpHacQ) · [CpkB9hHL…](https://explorer.testnet.near.org/transactions/CpkB9hHLyzxYfX1Htw5hbZ4yoLyvMcVoKenBCQ7gu2CX) | +60 / +48 / +36 PUSD, pro-rata |
| `refund` again | reverted | `already refunded this cycle` |

</details>

### Run the app

```bash
cd frontend && npm install && npm run dev    # http://localhost:3000
```

Four screens: campaign list → campaign (fund / attest / withdraw / finalize / refund) → create →
my support. Without `NEXT_PUBLIC_ESCROW_ID` it renders against bundled fixtures in **demo mode**,
so the UI is reviewable with no wallet and no testnet. To drive the deployed campaign, copy
`frontend/.env.example` to `frontend/.env.local` with the two account IDs above and sign in through
the Wallet Selector modal (Meteor Wallet testnet is bundled). Every amount is a `BigInt`; see
`frontend/README.md`.

## Layout

```
contract/            the escrow: 610 lines of Rust, near-sdk 5
  src/lib.rs         state machine + views + cross-contract callbacks
  tests/integration.rs  487 lines, 9 sandbox tests
token/               NEP-141 demo stable unit (148 lines) — not part of the submission's value
frontend/            Next.js 15 + React 19, raw JSON-RPC reads, Wallet Selector writes
scripts/view.py      read any view method in one line
scripts/repro-refund.sh  the whole refund story, on testnet, in one command
artifacts/           compiled wasm + ABI (gitignored; rebuild with the commands above)
```

## What is deliberately not here

- **No price feed, no real USD.** PUSD is a demo NEP-141 token; the escrow is token-agnostic by
  account id, so a real USDT/USDC on NEAR needs no contract change.
- **No off-chain delivery proofs.** Attestation is human. The obvious next step is tying a
  milestone to something checkable (a GitHub release, an IPFS hash) so votes have evidence.
- **No frontend deployment.** It runs locally in two modes; a hosted URL would need a public
  build with keys inlined at build time.
- **Quorum is money-weighted by design**, which means a single whale backer can decide a cycle.
  A per-account cap (`min(deposited, cap)` weight) is a one-line change if that is the wrong trade.

## Roadmap beyond the hackathon

Recurring cycles with an unattended refund option (claim-all in one transaction), milestone
deadlines that survive a paused campaign, and a reputation record per creator across campaigns —
stored on-chain, so a creator arrives at the next campaign with a verifiable delivery history
instead of a link to a profile.
