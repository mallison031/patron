/*!
Patron: cycle-based milestone escrow where undelivered milestones automatically refund supporters.

Money leaves the escrow to a creator only when supporters attesting a combined weight of at least
`quorum_bps` of the cycle pool confirm a milestone was delivered. Whatever is not confirmed by the
attestation deadline stays in the pool and is claimed back by supporters pro-rata. There is no
admin key, no arbiter, and no path by which the creator alone moves funds.
*/
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_contract_standards::storage_management::StorageBalance;
use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::{LookupMap, LookupSet};
use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, PromiseOrValue, env, ext_contract,
    log, near, require,
};

const GAS_FOR_TRANSFER: Gas = Gas::from_tgas(25);
const GAS_FOR_TRANSFER_CALLBACK: Gas = Gas::from_tgas(20);
const GAS_FOR_STORAGE_DEPOSIT: Gas = Gas::from_tgas(15);
const REGISTRATION_STORAGE_BYTES: u128 = 125;
/// ft_transfer requires exactly this attached deposit.
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const BPS: u128 = 10_000;

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Campaigns,
    Cycles,
    Deposits,
    AttestedWeight,
    AttestedBy,
    Refunded,
    RegisteredTokens,
}

#[ext_contract(ext_token)]
#[allow(dead_code)]
trait ExtToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance;
}

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct MilestoneSpec {
    pub title: String,
    /// Share of the cycle pool released when this milestone is attested, in basis points.
    pub weight_bps: u32,
    /// Seconds after a cycle opens that delivery is due.
    pub due_offset_sec: u64,
}

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct Campaign {
    pub id: u64,
    pub creator: AccountId,
    pub title: String,
    pub summary: String,
    pub reference_url: String,
    /// NEP-141 token holding the escrow.
    pub token: AccountId,
    pub milestones: Vec<MilestoneSpec>,
    /// Deposits are accepted until cycle_opens_at + this.
    pub contribution_window_sec: u64,
    /// Supporters may attest a delivered milestone until due_at + this.
    pub attestation_window_sec: u64,
    /// Combined supporter weight, in bps of the cycle pool, needed to release one milestone.
    pub quorum_bps: u32,
    pub cycle_count: u64,
    pub created_at: u64,
}

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct CycleState {
    pub opens_at: u64,
    pub contribution_deadline: u64,
    pub due_at: Vec<u64>,
    pub attestation_deadline: Vec<u64>,
    pub released_flags: Vec<bool>,
    pub total_deposited: u128,
    pub released: u128,
    pub supporter_count: u64,
    pub finalized: bool,
    /// Frozen at finalize so every supporter's pro-rata share uses the same denominator and the
    /// shares cannot drift as later supporters claim.
    pub snapshot_total: u128,
    pub snapshot_locked: u128,
}

#[near(serializers = [json])]
pub struct MilestoneStatus {
    pub index: u64,
    pub title: String,
    pub weight_bps: u32,
    pub due_at: u64,
    pub attestation_deadline: u64,
    pub attested_weight: U128,
    pub quorum_weight: U128,
    pub tranche_amount: U128,
    pub released: bool,
    pub window_open: bool,
    pub expired: bool,
}

#[near(serializers = [json])]
pub struct CycleView {
    pub campaign_id: u64,
    pub cycle: u64,
    pub opens_at: u64,
    pub contribution_deadline: u64,
    pub total_deposited: U128,
    pub released: U128,
    pub locked: U128,
    pub supporter_count: u64,
    pub finalized: bool,
    pub can_finalize: bool,
    pub milestones: Vec<MilestoneStatus>,
}

#[near(serializers = [json])]
pub struct CampaignView {
    pub id: u64,
    pub creator: AccountId,
    pub title: String,
    pub summary: String,
    pub reference_url: String,
    pub token: AccountId,
    pub milestones: Vec<MilestoneSpec>,
    pub contribution_window_sec: u64,
    pub attestation_window_sec: u64,
    pub quorum_bps: u32,
    pub current_cycle: u64,
    pub created_at: u64,
    pub token_registered: bool,
}

#[near(serializers = [json])]
pub struct SupporterView {
    pub supporter: AccountId,
    pub cycle: u64,
    pub deposited: U128,
    pub refund_share: U128,
    pub refunded: bool,
    pub attested_milestones: Vec<u64>,
    pub can_refund: bool,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    campaigns: LookupMap<u64, Campaign>,
    next_campaign_id: u64,
    cycles: LookupMap<(u64, u64), CycleState>,
    deposits: LookupMap<(u64, u64, AccountId), u128>,
    attested_weight: LookupMap<(u64, u64, u64), u128>,
    attested_by: LookupSet<(u64, u64, u64, AccountId)>,
    refunded: LookupSet<(u64, u64, AccountId)>,
    registered_tokens: LookupSet<AccountId>,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        require!(!env::state_exists(), "already initialized");
        Self {
            campaigns: LookupMap::new(StorageKey::Campaigns),
            next_campaign_id: 1,
            cycles: LookupMap::new(StorageKey::Cycles),
            deposits: LookupMap::new(StorageKey::Deposits),
            attested_weight: LookupMap::new(StorageKey::AttestedWeight),
            attested_by: LookupSet::new(StorageKey::AttestedBy),
            refunded: LookupSet::new(StorageKey::Refunded),
            registered_tokens: LookupSet::new(StorageKey::RegisteredTokens),
        }
    }

    /// Creates a campaign and opens cycle 1. Also registers this contract's own account for
    /// storage on `token`, which must have landed before any supporter's `ft_transfer_call`.
    #[allow(clippy::too_many_arguments)]
    pub fn create_campaign(
        &mut self,
        creator: AccountId,
        title: String,
        summary: String,
        reference_url: String,
        token: AccountId,
        milestones: Vec<MilestoneSpec>,
        contribution_window_sec: u64,
        attestation_window_sec: u64,
        quorum_bps: u32,
    ) -> u64 {
        require!(!milestones.is_empty(), "at least one milestone required");
        let weight_sum: u64 = milestones.iter().map(|m| m.weight_bps as u64).sum();
        require!(weight_sum as u128 == BPS, "milestone weights must sum to 10000 bps");
        require!(quorum_bps > 0 && (quorum_bps as u128) <= BPS, "quorum_bps must be in 1..=10000");
        require!(
            contribution_window_sec <= milestones[0].due_offset_sec,
            "contribution window must end before the first milestone is due"
        );
        require!(attestation_window_sec > 0, "attestation window must be positive");
        require!(title.len() <= 120 && summary.len() <= 500, "title or summary too long");
        require!(milestones.iter().all(|m| m.title.len() <= 120), "milestone title too long");

        let id = self.next_campaign_id;
        self.next_campaign_id += 1;
        let now = Self::now_sec();
        self.campaigns.insert(
            &id,
            &Campaign {
                id,
                creator: creator.clone(),
                title,
                summary,
                reference_url,
                token: token.clone(),
                milestones,
                contribution_window_sec,
                attestation_window_sec,
                quorum_bps,
                cycle_count: 0,
                created_at: now,
            },
        );
        self.open_cycle(id);

        if !self.registered_tokens.contains(&token) {
            self.registered_tokens.insert(&token);
            ext_token::ext(token.clone())
                .with_attached_deposit(Self::registration_cost())
                .with_static_gas(GAS_FOR_STORAGE_DEPOSIT)
                .storage_deposit(Some(env::current_account_id()), Some(true))
                .detach();
        }
        log!("campaign {} created by {}", id, creator);
        id
    }

    /// The creator opens the next cycle once the current one is finalized. Recurring patronage is
    /// this call repeated, and each cycle's undelivered funds refund independently.
    pub fn open_next_cycle(&mut self, campaign_id: u64) -> u64 {
        let campaign = self.load_campaign(campaign_id);
        require!(env::predecessor_account_id() == campaign.creator, "creator only");
        let current = self.load_cycle(campaign_id, campaign.cycle_count);
        require!(current.finalized, "current cycle must be finalized first");
        self.open_cycle(campaign_id);
        campaign.cycle_count + 1
    }

    /// A supporter records that milestone `index` was delivered. Voting weight is what that
    /// supporter deposited into this cycle, so the quorum is of the money, not of accounts.
    pub fn attest(&mut self, campaign_id: u64, cycle: u64, index: u64) {
        let supporter = env::predecessor_account_id();
        let state = self.load_cycle(campaign_id, cycle);
        require!(!state.finalized, "cycle is finalized");
        require!(index < state.due_at.len() as u64, "no such milestone");
        let i = index as usize;
        require!(!state.released_flags[i], "milestone already released");
        require!(Self::now_sec() >= state.due_at[i], "milestone is not due yet");
        require!(Self::now_sec() < state.attestation_deadline[i], "attestation window closed");

        let weight = self.load_deposit(campaign_id, cycle, &supporter);
        require!(weight > 0, "only this cycle's supporters can attest");
        let akey = (campaign_id, cycle, index, supporter.clone());
        require!(!self.attested_by.contains(&akey), "already attested");
        self.attested_by.insert(&akey);
        let wkey = (campaign_id, cycle, index);
        let total = self.load_attested_weight(campaign_id, cycle, index) + weight;
        self.attested_weight.insert(&wkey, &total);
        log!("{} attested milestone {} of campaign {} cycle {}", supporter, index, campaign_id, cycle);
    }

    /// Releases one milestone's tranche to the creator, and only against a supporter quorum.
    pub fn withdraw(&mut self, campaign_id: u64, cycle: u64, index: u64) {
        let campaign = self.load_campaign(campaign_id);
        require!(env::predecessor_account_id() == campaign.creator, "creator only");
        let mut state = self.load_cycle(campaign_id, cycle);
        require!(!state.finalized, "cycle is finalized");
        require!(index < state.due_at.len() as u64, "no such milestone");
        let i = index as usize;
        require!(!state.released_flags[i], "milestone already released");
        require!(Self::now_sec() >= state.due_at[i], "milestone not due yet");
        require!(
            Self::now_sec() < state.attestation_deadline[i],
            "attestation window closed; this milestone is permanently refundable"
        );

        let attested = self.load_attested_weight(campaign_id, cycle, index);
        let quorum = state.total_deposited * campaign.quorum_bps as u128 / BPS;
        require!(attested > 0 && attested >= quorum, "supporter quorum not reached");

        let amount =
            state.total_deposited * campaign.milestones[i].weight_bps as u128 / BPS;
        require!(state.released + amount <= state.total_deposited, "tranche exceeds pool");
        state.released_flags[i] = true;
        state.released += amount;
        self.cycles.insert(&(campaign_id, cycle), &state);

        if amount == 0 {
            log!("milestone {} of campaign {} cycle {} has nothing to release", index, campaign_id, cycle);
            return;
        }

        ext_token::ext(campaign.token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_TRANSFER)
            .ft_transfer(
                campaign.creator.clone(),
                U128(amount.into()),
                Some(format!("campaign {campaign_id} cycle {cycle} milestone {index}")),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_TRANSFER_CALLBACK)
                    .on_release_result(campaign_id, cycle, index, amount),
            )
            .detach();
    }

    /// Anyone may finalize a cycle once every attestation window has closed. This freezes the
    /// refund denominator so supporters' shares cannot drift as people claim.
    pub fn finalize_cycle(&mut self, campaign_id: u64, cycle: u64) {
        let mut state = self.load_cycle(campaign_id, cycle);
        require!(!state.finalized, "already finalized");
        let last = state.attestation_deadline.iter().max().copied().unwrap_or(0);
        require!(Self::now_sec() >= last, "attestation windows still open");
        state.finalized = true;
        state.snapshot_total = state.total_deposited;
        state.snapshot_locked = state.total_deposited - state.released;
        self.cycles.insert(&(campaign_id, cycle), &state);
        log!(
            "cycle {} of campaign {} finalized: {} released to creator, {} refundable",
            cycle,
            campaign_id,
            state.released,
            state.snapshot_locked
        );
    }

    /// A supporter claims back their pro-rata share of everything the campaign failed to deliver.
    pub fn refund(&mut self, campaign_id: u64, cycle: u64) {
        let campaign = self.load_campaign(campaign_id);
        let supporter = env::predecessor_account_id();
        let state = self.load_cycle(campaign_id, cycle);
        require!(state.finalized, "finalize the cycle before refunding");
        let rkey = (campaign_id, cycle, supporter.clone());
        require!(!self.refunded.contains(&rkey), "already refunded this cycle");
        let deposited = self.load_deposit(campaign_id, cycle, &supporter);
        require!(deposited > 0, "no deposit in this cycle");

        let amount = if state.snapshot_total > 0 {
            deposited * state.snapshot_locked / state.snapshot_total
        } else {
            0
        };
        require!(amount > 0, "nothing to refund: this cycle delivered in full");
        self.refunded.insert(&rkey);

        ext_token::ext(campaign.token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_TRANSFER)
            .ft_transfer(
                supporter.clone(),
                U128(amount.into()),
                Some(format!("campaign {campaign_id} cycle {cycle} refund")),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_TRANSFER_CALLBACK)
                    .on_refund_result(campaign_id, cycle, supporter.clone(), deposited, amount),
            )
            .detach();
        log!("{} refunded {} for campaign {} cycle {}", supporter, amount, campaign_id, cycle);
    }

    /// Reverts a release whose payout transfer failed, so a creator's unregistered storage can
    /// never silently burn supporter money.
    #[private]
    pub fn on_release_result(&mut self, campaign_id: u64, cycle: u64, index: u64, amount: u128) {
        if Self::promise_ok() {
            return;
        }
        let mut state = self.load_cycle(campaign_id, cycle);
        state.released -= amount;
        state.released_flags[index as usize] = false;
        self.cycles.insert(&(campaign_id, cycle), &state);
        log!("payout to creator failed; {} restored to the cycle pool", amount);
    }

    #[private]
    pub fn on_refund_result(
        &mut self,
        campaign_id: u64,
        cycle: u64,
        supporter: AccountId,
        _deposited: u128,
        amount: u128,
    ) {
        if Self::promise_ok() {
            return;
        }
        self.refunded.remove(&(campaign_id, cycle, supporter.clone()));
        log!("refund to {} of {} failed; supporter may claim again", supporter, amount);
    }

    pub fn get_campaign(&self, campaign_id: u64) -> CampaignView {
        let c = self.load_campaign(campaign_id);
        CampaignView {
            id: c.id,
            creator: c.creator,
            title: c.title,
            summary: c.summary,
            reference_url: c.reference_url,
            token: c.token.clone(),
            milestones: c.milestones,
            contribution_window_sec: c.contribution_window_sec,
            attestation_window_sec: c.attestation_window_sec,
            quorum_bps: c.quorum_bps,
            current_cycle: c.cycle_count,
            created_at: c.created_at,
            token_registered: self.registered_tokens.contains(&c.token),
        }
    }

    pub fn get_cycle(&self, campaign_id: u64, cycle: u64) -> CycleView {
        let campaign = self.load_campaign(campaign_id);
        let state = self.load_cycle(campaign_id, cycle);
        let now = Self::now_sec();
        let milestones = campaign
            .milestones
            .iter()
            .enumerate()
            .map(|(i, m)| MilestoneStatus {
                index: i as u64,
                title: m.title.clone(),
                weight_bps: m.weight_bps,
                due_at: state.due_at[i],
                attestation_deadline: state.attestation_deadline[i],
                attested_weight: U128(
                    self.attested_weight
                        .get(&(campaign_id, cycle, i as u64))
                        .unwrap_or(0)
                        .into(),
                ),
                quorum_weight: U128((state.total_deposited * campaign.quorum_bps as u128 / BPS).into()),
                tranche_amount: U128((state.total_deposited * m.weight_bps as u128 / BPS).into()),
                released: state.released_flags[i],
                window_open: now >= state.due_at[i] && now < state.attestation_deadline[i],
                expired: !state.released_flags[i] && now >= state.attestation_deadline[i],
            })
            .collect();
        CycleView {
            campaign_id,
            cycle,
            opens_at: state.opens_at,
            contribution_deadline: state.contribution_deadline,
            total_deposited: U128(state.total_deposited.into()),
            released: U128(state.released.into()),
            locked: U128((state.total_deposited - state.released).into()),
            supporter_count: state.supporter_count,
            finalized: state.finalized,
            can_finalize: !state.finalized && now >= state.attestation_deadline.iter().max().copied().unwrap_or(0),
            milestones,
        }
    }

    pub fn get_supporter(&self, campaign_id: u64, cycle: u64, supporter: AccountId) -> SupporterView {
        let state = self.load_cycle(campaign_id, cycle);
        let deposited = self.load_deposit(campaign_id, cycle, &supporter);
        let refunded = self.refunded.contains(&(campaign_id, cycle, supporter.clone()));
        let attested_milestones = (0..state.due_at.len() as u64)
            .filter(|i| self.attested_by.contains(&(campaign_id, cycle, *i, supporter.clone())))
            .collect();
        let refund_share = if state.finalized && state.snapshot_total > 0 {
            deposited * state.snapshot_locked / state.snapshot_total
        } else {
            0
        };
        SupporterView {
            supporter: supporter.clone(),
            cycle,
            deposited: U128(deposited.into()),
            refund_share: U128(refund_share.into()),
            refunded,
            attested_milestones,
            can_refund: state.finalized && deposited > 0 && !refunded && refund_share > 0,
        }
    }

    pub fn list_campaigns(&self, from: Option<u64>, limit: Option<u8>) -> Vec<u64> {
        let from = from.unwrap_or(1).max(1);
        let limit = limit.unwrap_or(25).min(50) as usize;
        (from..self.next_campaign_id).take(limit).collect()
    }

    fn open_cycle(&mut self, campaign_id: u64) {
        let mut campaign = self.load_campaign(campaign_id);
        let cycle = campaign.cycle_count + 1;
        let opens_at = Self::now_sec();
        let due_at: Vec<u64> =
            campaign.milestones.iter().map(|m| opens_at + m.due_offset_sec).collect();
        let attestation_deadline: Vec<u64> = due_at
            .iter()
            .map(|d| d + campaign.attestation_window_sec)
            .collect();
        self.cycles.insert(
            &(campaign_id, cycle),
            &CycleState {
                opens_at,
                contribution_deadline: opens_at + campaign.contribution_window_sec,
                released_flags: vec![false; campaign.milestones.len()],
                due_at,
                attestation_deadline,
                total_deposited: 0,
                released: 0,
                supporter_count: 0,
                finalized: false,
                snapshot_total: 0,
                snapshot_locked: 0,
            },
        );
        campaign.cycle_count = cycle;
        self.campaigns.insert(&campaign_id, &campaign);
        log!("cycle {} of campaign {} opened at {}", cycle, campaign_id, opens_at);
    }

    fn load_campaign(&self, campaign_id: u64) -> Campaign {
        self.campaigns.get(&campaign_id).expect("campaign does not exist")
    }

    fn load_cycle(&self, campaign_id: u64, cycle: u64) -> CycleState {
        self.cycles.get(&(campaign_id, cycle)).expect("cycle does not exist")
    }

    fn load_deposit(&self, campaign_id: u64, cycle: u64, supporter: &AccountId) -> u128 {
        self.deposits.get(&(campaign_id, cycle, supporter.clone())).unwrap_or(0)
    }

    fn load_attested_weight(&self, campaign_id: u64, cycle: u64, index: u64) -> u128 {
        self.attested_weight.get(&(campaign_id, cycle, index)).unwrap_or(0)
    }

    fn registration_cost() -> NearToken {
        env::storage_byte_cost().saturating_mul(REGISTRATION_STORAGE_BYTES)
    }

    fn now_sec() -> u64 {
        env::block_timestamp() / 1_000_000_000
    }

    fn promise_ok() -> bool {
        env::promise_result_checked(0, 32).is_ok()
    }
}

#[near]
impl FungibleTokenReceiver for Contract {
    /// Deposits arrive as `ft_transfer_call(escrow, amount, memo, "<campaign_id>:<cycle_id>")`.
    /// Anything this contract will not accept is returned to the sender by the token contract.
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let rejected = PromiseOrValue::Value(amount);
        let Some((campaign_id, cycle)) = parse_msg(&msg) else {
            log!("deposit of {} rejected: malformed msg {}", amount.0, msg);
            return rejected;
        };
        let Some(campaign) = self.campaigns.get(&campaign_id) else {
            log!("deposit of {} rejected: no campaign {}", amount.0, campaign_id);
            return rejected;
        };
        require!(env::predecessor_account_id() == campaign.token, "wrong token for this campaign");
        let Some(mut state) = self.cycles.get(&(campaign_id, cycle)) else {
            log!("deposit of {} rejected: no cycle {} in campaign {}", amount.0, cycle, campaign_id);
            return rejected;
        };
        if state.finalized || Self::now_sec() >= state.contribution_deadline || amount.0 == 0 {
            log!("deposit of {} rejected for campaign {} cycle {}", amount.0, campaign_id, cycle);
            return rejected;
        }

        let key = (campaign_id, cycle, sender_id.clone());
        let before = self.deposits.get(&key).unwrap_or(0);
        if before == 0 {
            state.supporter_count += 1;
        }
        self.deposits.insert(&key, &(before + amount.0));
        state.total_deposited += amount.0;
        self.cycles.insert(&(campaign_id, cycle), &state);
        log!("{} funded campaign {} cycle {} with {}", sender_id, campaign_id, cycle, amount.0);
        PromiseOrValue::Value(U128(0))
    }
}

fn parse_msg(msg: &str) -> Option<(u64, u64)> {
    let (a, b) = msg.split_once(':')?;
    Some((a.parse().ok()?, b.parse().ok()?))
}
