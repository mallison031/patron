# Patron frontend

Four screens over the escrow contract:

| route              | what it does                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`                | campaigns with pool, released, refundable and deposit deadline                                                                               |
| `/create`          | milestone builder — weights in bps, live check that they sum to 10000 and that deposits close before the first milestone is due              |
| `/campaign/[id]`   | milestone table with attested weight against quorum, one-click backing, creator release, finalize, refund, next cycle                        |
| `/me`              | every cycle you funded: deposit, refund share, attestations, claim button                                                                     |

## Run it

```bash
cp .env.example .env.local     # fill in your deployed accounts
pnpm install                   # npm install works too
pnpm dev                       # http://localhost:3000
```

With no `.env.local` at all the app runs in **demo mode**: the same screens render bundled
fixtures shaped exactly like the contract's views, so the UI is reviewable without a wallet, an
account, or RPC. Demo mode is forced whenever `NEXT_PUBLIC_ESCROW_ID` is unset; actions report what
they would sign instead of pretending to succeed.

## How it talks to the chain

- **Reads** are plain JSON-RPC `query` / `request_type: call_function` requests (`src/lib/api.ts`) —
  no SDK, they work server-side and in the browser, and `scripts/view.py` replays the identical
  request from a terminal. (The legacy `call` method is not served by every RPC; it 404s on
  `rpc.testnet.near.org`.)
- **Writes** go through [Wallet Selector](https://github.com/near/wallet-selector) v10 with the
  Meteor Wallet module. Actions are built with `@near-js/transactions` `actionCreators.functionCall`
  (`src/lib/wallet.tsx`).
- **Backing is one click**: if your account has no balance record on the token yet, the app batches
  `storage_deposit` and `ft_transfer_call` into a single `signAndSendTransactions` call.
- `src/lib/buffer-shim.ts` installs `Buffer` for the browser, which `@near-js/transactions` needs to
  serialize actions.

Amounts are shown in the token's base unit (`NEXT_PUBLIC_TOKEN_DECIMALS`, default 6).

## Verification status

- Reads against the deployed testnet contracts: **exercised** — `/`, `/campaign/1` and `/campaign/2`
  render live pool, attested weight, quorum and refund state, with zero console errors.
- Demo mode (fixtures, no wallet, no RPC): **exercised** through all four screens.
- Writes through the Wallet Selector modal: **built but not yet driven by a human**, because it needs
  a real Meteor Wallet sign-in. The identical transactions are proven on-chain by
  `../scripts/repro-refund.sh`, which signs the same calls with near-cli.
