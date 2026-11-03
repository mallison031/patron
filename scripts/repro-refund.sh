#!/usr/bin/env bash
# One full Patron cycle against the deployed testnet contracts:
# fund -> attest one milestone -> release it -> let the next lapse -> finalize -> refund pro-rata.
#
# Needs near-cli with a keychain key for every signer (see README "Run it with your own accounts")
# and PUSD + ~1.25 NEAR in each backer. Prints the on-chain state after every step.
set -euo pipefail

ESCROW=${ESCROW:-patron-escrow-hackathon.testnet}
TOKEN=${TOKEN:-patron-pusd-hackathon.testnet}
CREATOR=${CREATOR:-patrondemo.testnet}
BACKERS=${BACKERS:-"alice.patrondemo.testnet:100 s2.patrondemo.testnet:80 s3.patrondemo.testnet:60"}

# Windows are seconds from the moment the cycle opens, so a run takes about three minutes.
CONTRIBUTION=${CONTRIBUTION:-45}
DUE_1=${DUE_1:-60}
DUE_2=${DUE_2:-90}
ATTEST=${ATTEST:-45}
QUORUM_BPS=${QUORUM_BPS:-5000}

UNIT=1000000 # PUSD has 6 decimals
here=$(cd "$(dirname "$0")/.." && pwd)

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

explink() {
  printf '%s\n' "$1" \
    | sed -n 's|.*Transaction ID: \([A-Za-z0-9]*\).*|    https://explorer.testnet.near.org/transactions/\1|p' \
    | head -1
}

# tx <signer> <contract> <method> <json-args> [deposit] -> prints the explorer link, fails loudly
tx() {
  local signer=$1 contract=$2 method=$3 args=$4 deposit=${5:-0 NEAR} out
  out=$(near contract call-function as-transaction "$contract" "$method" json-args "$args" \
    prepaid-gas '100 Tgas' attached-deposit "$deposit" \
    sign-as "$signer" network-config testnet sign-with-legacy-keychain send 2>&1)
  if ! printf '%s\n' "$out" | grep -q 'succeeded'; then
    printf '%s\n' "$out" | tail -12
    return 1
  fi
  explink "$out"
}

pusd() { python3 "$here/scripts/view.py" "$TOKEN" ft_balance_of "{\"account_id\":\"$1\"}" | tr -d '"'; }
cycle() { python3 "$here/scripts/view.py" "$ESCROW" get_cycle "{\"campaign_id\":$1,\"cycle\":1}"; }
supporter() {
  python3 "$here/scripts/view.py" "$ESCROW" get_supporter \
    "{\"campaign_id\":$1,\"cycle\":1,\"supporter\":\"$2\"}"
}
sleep_until() { while [ "$(date +%s)" -lt "$1" ]; do sleep 2; done; }

say "create the campaign"
out=$(near contract call-function as-transaction "$ESCROW" create_campaign json-args "$(jq -nc \
  --arg creator "$CREATOR" --arg token "$TOKEN" \
  --argjson c "$CONTRIBUTION" --argjson d1 "$DUE_1" --argjson d2 "$DUE_2" \
  --argjson a "$ATTEST" --argjson q "$QUORUM_BPS" \
  '{creator:$creator, title:"Repro run",
    summary:"A supporter quorum releases each tranche; a lapsed milestone refunds pro-rata.",
    reference_url:"https://near.org", token:$token,
    milestones:[{title:"delivered", weight_bps:4000, due_offset_sec:$d1},
                {title:"missed", weight_bps:6000, due_offset_sec:$d2}],
    contribution_window_sec:$c, attestation_window_sec:$a, quorum_bps:$q}')" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  sign-as "$CREATOR" network-config testnet sign-with-legacy-keychain send 2>&1)
id=$(printf '%s\n' "$out" | awk '/return value/{getline; print; exit}')
[ -n "$id" ] || { printf '%s\n' "$out" | tail -12; exit 1; }
printf '    campaign %s\n' "$id"
explink "$out"
opened=$(cycle "$id" | jq -r .opens_at)

say "back it: ft_transfer_call into the escrow"
for entry in $BACKERS; do
  account=${entry%%:*}
  units=${entry##*:}
  tx "$account" "$TOKEN" ft_transfer_call "$(jq -nc \
    --arg escrow "$ESCROW" --arg amount "$((units * UNIT))" --arg msg "$id:1" \
    '{receiver_id:$escrow, amount:$amount, memo:null, msg:$msg}')" '1 yoctoNEAR'
done
state=$(cycle "$id")
printf '    pool = %s, one milestone needs %s of attested weight\n' \
  "$(jq -r .total_deposited <<<"$state")" "$(jq -r '.milestones[0].quorum_weight' <<<"$state")"

say "attest milestone 0 — the one that ships"
sleep_until "$((opened + DUE_1 + 2))"
for entry in $BACKERS; do
  tx "${entry%%:*}" "$ESCROW" attest \
    "$(jq -nc --argjson c "$id" '{campaign_id:$c, cycle:1, index:0}')" || true
done
printf '    attested weight = %s\n' "$(cycle "$id" | jq -r '.milestones[0].attested_weight')"

say "creator withdraws milestone 0"
before=$(pusd "$CREATOR")
tx "$CREATOR" "$ESCROW" withdraw "$(jq -nc --argjson c "$id" '{campaign_id:$c, cycle:1, index:0}')"
printf '    creator PUSD %s -> %s\n' "$before" "$(pusd "$CREATOR")"

say "milestone 1 is never delivered: wait out its attestation window"
lapse=$(cycle "$id" | jq -r '.milestones[-1].attestation_deadline')
sleep_until "$((lapse + 2))"

say "anyone finalizes the cycle — that snapshots what is refundable"
tx "$CREATOR" "$ESCROW" finalize_cycle "$(jq -nc --argjson c "$id" '{campaign_id:$c, cycle:1}')"
printf '    locked = %s of %s\n' \
  "$(cycle "$id" | jq -r .locked)" "$(cycle "$id" | jq -r .total_deposited)"

say "each backer claims their pro-rata refund"
for entry in $BACKERS; do
  account=${entry%%:*}
  before=$(pusd "$account")
  tx "$account" "$ESCROW" refund "$(jq -nc --argjson c "$id" '{campaign_id:$c, cycle:1}')"
  printf '    %s PUSD %s -> %s\n' "$account" "$before" "$(pusd "$account")"
done

say "guards"
first_backer=${BACKERS%%:*}
if tx "$first_backer" "$ESCROW" refund "$(jq -nc --argjson c "$id" '{campaign_id:$c, cycle:1}')" >/dev/null 2>&1; then
  echo '    FAIL: a second refund was accepted'
else
  echo '    second refund rejected: already refunded this cycle'
fi
printf '    escrow still holds %s PUSD\n' "$(pusd "$ESCROW")"
printf '    supporter view: %s\n' "$(supporter "$id" "$first_backer" | jq -c '{deposited, refund_share, refunded, can_refund}')"
