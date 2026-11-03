use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::network::Sandbox;
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

const UNIT: u128 = 1_000_000; // PUSD has 6 decimals
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const CALL_GAS: Gas = Gas::from_tgas(100);

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

struct Ctx {
    worker: Worker<Sandbox>,
    escrow: Contract,
    token: Contract,
    creator: Account,
    alice: Account,
    bob: Account,
}

fn S(units: u128) -> String {
    (units * UNIT).to_string()
}

impl Ctx {
    async fn try_create_campaign(
        &self,
        creator: &AccountId,
        milestones: Value,
        quorum_bps: u32,
        contribution_window_sec: u64,
    ) -> Result<ExecutionFinalResult> {
        Ok(self
            .escrow
            .call("create_campaign")
            .args_json(json!({
                "creator": creator.to_string(),
                "title": "Zine: eight issues",
                "summary": "one issue a month, refunded when a month is missed",
                "reference_url": "https://example.com/zine",
                "token": self.token.id().to_string(),
                "milestones": milestones,
                "contribution_window_sec": contribution_window_sec,
                "attestation_window_sec": 30u64,
                "quorum_bps": quorum_bps,
            }))
            .max_gas()
            .transact()
            .await?)
    }

    async fn create_campaign(&self, creator: &AccountId, milestones: Value, quorum_bps: u32) -> Result<u64> {
        let res = self.try_create_campaign(creator, milestones, quorum_bps, 20).await?;
        Ok(res.into_result()?.json::<u64>()?)
    }

    /// Two milestones, each worth half the pool, due at 30s and 60s, 50% quorum.
    async fn default_campaign(&self) -> Result<u64> {
        self.create_campaign(
            self.creator.id(),
            json!([
                {"title": "issues 1-4", "weight_bps": 5000u32, "due_offset_sec": 30u64},
                {"title": "issues 5-8", "weight_bps": 5000u32, "due_offset_sec": 60u64},
            ]),
            5000,
        )
        .await
    }

    async fn fund(
        &self,
        backer: &Account,
        campaign: u64,
        cycle: u64,
        units: u128,
        msg: Option<String>,
    ) -> Result<ExecutionFinalResult> {
        Ok(backer
            .call(self.token.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": self.escrow.id().to_string(),
                "amount": S(units),
                "memo": null,
                "msg": msg.unwrap_or_else(|| format!("{campaign}:{cycle}")),
            }))
            .deposit(ONE_YOCTO)
            .max_gas()
            .transact()
            .await?)
    }

    async fn attest(&self, who: &Account, campaign: u64, cycle: u64, index: u64) -> Result<ExecutionFinalResult> {
        self.send(who, "attest", json!({"campaign_id": campaign, "cycle": cycle, "index": index})).await
    }

    async fn withdraw(&self, who: &Account, campaign: u64, cycle: u64, index: u64) -> Result<ExecutionFinalResult> {
        self.send(who, "withdraw", json!({"campaign_id": campaign, "cycle": cycle, "index": index})).await
    }

    async fn finalize(&self, who: &Account, campaign: u64, cycle: u64) -> Result<ExecutionFinalResult> {
        self.send(who, "finalize_cycle", json!({"campaign_id": campaign, "cycle": cycle})).await
    }

    async fn refund(&self, who: &Account, campaign: u64, cycle: u64) -> Result<ExecutionFinalResult> {
        self.send(who, "refund", json!({"campaign_id": campaign, "cycle": cycle})).await
    }

    async fn open_next_cycle(&self, who: &Account, campaign: u64) -> Result<ExecutionFinalResult> {
        self.send(who, "open_next_cycle", json!({"campaign_id": campaign})).await
    }

    async fn send(&self, who: &Account, method: &str, args: Value) -> Result<ExecutionFinalResult> {
        Ok(who.call(self.escrow.id(), method).args_json(args).gas(CALL_GAS).transact().await?)
    }

    async fn cycle(&self, campaign: u64, cycle: u64) -> Result<Value> {
        Ok(self
            .escrow
            .call("get_cycle")
            .args_json(json!({"campaign_id": campaign, "cycle": cycle}))
            .max_gas()
            .view()
            .await?
            .json::<Value>()?)
    }

    async fn supporter(&self, who: &Account, campaign: u64, cycle: u64) -> Result<Value> {
        Ok(self
            .escrow
            .call("get_supporter")
            .args_json(json!({
                "campaign_id": campaign,
                "cycle": cycle,
                "supporter": who.id().to_string(),
            }))
            .max_gas()
            .view()
            .await?
            .json::<Value>()?)
    }

    async fn balance(&self, who: &AccountId) -> Result<u128> {
        let raw: String = self
            .token
            .call("ft_balance_of")
            .args_json(json!({"account_id": who.to_string()}))
            .max_gas()
            .view()
            .await?
            .json()?;
        Ok(raw.parse::<u128>()? / UNIT)
    }

    /// Advance the sandbox clock by at least `seconds`. `fast_forward` only moves ~0.29s per
    /// block, so loop against the network clock rather than guessing a block count.
    async fn ff(&self, seconds: u64) -> Result<()> {
        let target = self.clock().await? + seconds * 1_000_000_000;
        for _ in 0..400 {
            if self.clock().await? >= target {
                return Ok(());
            }
            self.worker.fast_forward(4).await?;
        }
        Err("sandbox clock never reached the target".into())
    }

    async fn clock(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp())
    }
}

async fn funded_account(worker: &Worker<Sandbox>, token: &Contract, root: &Account, name: &str) -> Result<Account> {
    let account = root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    token
        .call("storage_deposit")
        .args_json(json!({"account_id": account.id().to_string(), "registration_only": true}))
        .deposit(NearToken::from_millinear(50))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    root
        .call(token.id(), "ft_transfer")
        .args_json(json!({"receiver_id": account.id().to_string(), "amount": S(1_000), "memo": null}))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(account)
}

async fn setup() -> Result<Ctx> {
    let worker = near_workspaces::sandbox_with_version("2.14.0").await?;
    let root = worker.root_account()?;

    let token = worker.dev_deploy(&std::fs::read("../artifacts/patron_test_token.wasm")?).await?;
    token
        .call("new")
        .args_json(json!({"owner_id": root.id().to_string(), "total_supply": S(1_000_000)}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let escrow = worker.dev_deploy(&std::fs::read("../artifacts/patron_escrow.wasm")?).await?;
    escrow.call("new").args_json(json!({})).max_gas().transact().await?.into_result()?;

    let creator = funded_account(&worker, &token, &root, "creator").await?;
    let alice = funded_account(&worker, &token, &root, "alice").await?;
    let bob = funded_account(&worker, &token, &root, "bob").await?;

    Ok(Ctx { worker, escrow, token, creator, alice, bob })
}

#[tokio::test]
async fn deposit_records_weight_and_moves_tokens() -> Result<()> {
    let ctx = setup().await?;
    let campaign = ctx.default_campaign().await?;

    let before = ctx.balance(ctx.alice.id()).await?;
    ctx.fund(&ctx.alice, campaign, 1, 60, None).await?.into_result()?;
    assert_eq!(ctx.balance(ctx.alice.id()).await?, before - 60);

    let cycle = ctx.cycle(campaign, 1).await?;
    assert_eq!(cycle["total_deposited"].as_str(), Some("60000000"));
    assert_eq!(cycle["supporter_count"].as_u64(), Some(1));

    ctx.fund(&ctx.bob, campaign, 1, 40, None).await?.into_result()?;
    let cycle = ctx.cycle(campaign, 1).await?;
    assert_eq!(cycle["total_deposited"].as_str(), Some("100000000"));
    assert_eq!(cycle["supporter_count"].as_u64(), Some(2));
    Ok(())
}

#[tokio::test]
async fn late_or_malformed_deposits_are_returned_to_the_backer() -> Result<()> {
    let ctx = setup().await?;
    let campaign = ctx.default_campaign().await?;
    ctx.fund(&ctx.alice, campaign, 1, 60, None).await?.into_result()?;

    ctx.ff(25).await?; // past the 20s contribution window
    let before = ctx.balance(ctx.bob.id()).await?;
    let res = ctx.fund(&ctx.bob, campaign, 1, 40, None).await?;
    assert!(res.is_success(), "a bounce must not fail the outer transfer");
    assert_eq!(ctx.balance(ctx.bob.id()).await?, before, "late deposit must come back");

    let res = ctx.fund(&ctx.bob, campaign, 1, 10, Some("nonsense".into())).await?;
    assert!(res.is_success());
    let res = ctx.fund(&ctx.bob, campaign, 99, 10, Some("999:1".into())).await?;
    assert!(res.is_success());

    assert_eq!(ctx.balance(ctx.bob.id()).await?, before);
    assert_eq!(ctx.cycle(campaign, 1).await?["total_deposited"].as_str(), Some("60000000"));
    Ok(())
}

#[tokio::test]
async fn release_requires_a_supporter_quorum_then_pays_the_creator() -> Result<()> {
    let ctx = setup().await?;
    let campaign = ctx.default_campaign().await?;
    ctx.fund(&ctx.alice, campaign, 1, 60, None).await?.into_result()?;
    ctx.fund(&ctx.bob, campaign, 1, 40, None).await?.into_result()?;

    ctx.ff(31).await?; // milestone 0 is due and its window is open

    assert!(ctx.withdraw(&ctx.creator, campaign, 1, 0).await?.is_failure(), "no attestation yet");

    let outsider = ctx.worker.root_account()?;
    assert!(ctx.attest(&outsider, campaign, 1, 0).await?.is_failure(), "only depositors carry weight");

    // bob alone is 40% of the pool, under a 50% quorum
    ctx.attest(&ctx.bob, campaign, 1, 0).await?.into_result()?;
    assert!(ctx.withdraw(&ctx.creator, campaign, 1, 0).await?.is_failure(), "40% must not satisfy 50%");
    assert!(ctx.attest(&ctx.bob, campaign, 1, 0).await?.is_failure(), "no double attestation");

    ctx.attest(&ctx.alice, campaign, 1, 0).await?.into_result()?;
    let before = ctx.balance(ctx.creator.id()).await?;
    ctx.withdraw(&ctx.creator, campaign, 1, 0).await?.into_result()?;
    assert_eq!(ctx.balance(ctx.creator.id()).await?, before + 50);

    let cycle = ctx.cycle(campaign, 1).await?;
    assert_eq!(cycle["released"].as_str(), Some("50000000"));
    assert_eq!(cycle["locked"].as_str(), Some("50000000"));
    assert!(cycle["milestones"][0]["released"].as_bool().unwrap());
    assert!(!cycle["milestones"][1]["released"].as_bool().unwrap());

    assert!(ctx.withdraw(&ctx.creator, campaign, 1, 0).await?.is_failure(), "no double payout");
    Ok(())
}

#[tokio::test]
async fn release_is_refused_before_the_milestone_is_due() -> Result<()> {
    let ctx = setup().await?;
    let campaign = ctx.default_campaign().await?;
    ctx.fund(&ctx.alice, campaign, 1, 100, None).await?.into_result()?;
    // no fast-forward: milestone 0 is not due until 30s
    assert!(ctx.attest(&ctx.alice, campaign, 1, 0).await?.is_failure(), "cannot attest early");
    assert!(ctx.withdraw(&ctx.creator, campaign, 1, 0).await?.is_failure(), "cannot pay before due");
    Ok(())
}

#[tokio::test]
async fn undelivered_milestone_refunds_supporters_pro_rata() -> Result<()> {
    let ctx = setup().await?;
    let campaign = ctx.default_campaign().await?;
    ctx.fund(&ctx.alice, campaign, 1, 60, None).await?.into_result()?;
    ctx.fund(&ctx.bob, campaign, 1, 40, None).await?.into_result()?;

    ctx.ff(31).await?;
    ctx.attest(&ctx.alice, campaign, 1, 0).await?.into_result()?;
    ctx.withdraw(&ctx.creator, campaign, 1, 0).await?.into_result()?;

    assert!(ctx.finalize(&ctx.alice, campaign, 1).await?.is_failure(), "windows still open");

    ctx.ff(70).await?; // ~101s, past both attestation deadlines
    assert!(ctx.withdraw(&ctx.creator, campaign, 1, 1).await?.is_failure(), "expired milestone is permanently refundable");

    ctx.finalize(&ctx.alice, campaign, 1).await?.into_result()?;
    assert_eq!(ctx.cycle(campaign, 1).await?["locked"].as_str(), Some("50000000"));

    let alice_before = ctx.balance(ctx.alice.id()).await?;
    let bob_before = ctx.balance(ctx.bob.id()).await?;
    ctx.refund(&ctx.alice, campaign, 1).await?.into_result()?;
    ctx.refund(&ctx.bob, campaign, 1).await?.into_result()?;

    // half the pool paid the creator; the rest splits 60/40 between backers
    assert_eq!(ctx.balance(ctx.alice.id()).await?, alice_before + 30);
    assert_eq!(ctx.balance(ctx.bob.id()).await?, bob_before + 20);

    assert!(ctx.refund(&ctx.bob, campaign, 1).await?.is_failure(), "one refund per supporter per cycle");
    let view = ctx.supporter(&ctx.alice, campaign, 1).await?;
    assert_eq!(view["refunded"].as_bool(), Some(true));
    assert_eq!(view["can_refund"].as_bool(), Some(false));
    Ok(())
}

#[tokio::test]
async fn fully_delivered_cycle_refunds_nothing() -> Result<()> {
    let ctx = setup().await?;
    let campaign = ctx.default_campaign().await?;
    ctx.fund(&ctx.alice, campaign, 1, 100, None).await?.into_result()?;
    let creator_before = ctx.balance(ctx.creator.id()).await?;

    ctx.ff(31).await?;
    ctx.attest(&ctx.alice, campaign, 1, 0).await?.into_result()?;
    ctx.withdraw(&ctx.creator, campaign, 1, 0).await?.into_result()?;

    ctx.ff(35).await?; // ~66s, milestone 1 due at 60s
    ctx.attest(&ctx.alice, campaign, 1, 1).await?.into_result()?;
    ctx.withdraw(&ctx.creator, campaign, 1, 1).await?.into_result()?;

    ctx.ff(30).await?; // past the last window at 90s
    ctx.finalize(&ctx.alice, campaign, 1).await?.into_result()?;
    assert_eq!(ctx.cycle(campaign, 1).await?["locked"].as_str(), Some("0"));

    assert!(ctx.refund(&ctx.alice, campaign, 1).await?.is_failure(), "nothing left to refund");
    assert_eq!(ctx.balance(ctx.creator.id()).await?, creator_before + 100);
    Ok(())
}

#[tokio::test]
async fn failed_payout_rolls_back_instead_of_burning_supporter_money() -> Result<()> {
    let ctx = setup().await?;
    let root = ctx.worker.root_account()?;
    // funded with NEAR but never registered on PUSD, so ft_transfer to it fails
    let ghost = root
        .create_subaccount("ghostcreator")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;

    let campaign = ctx
        .create_campaign(
            ghost.id(),
            json!([{"title": "one", "weight_bps": 10000u32, "due_offset_sec": 30u64}]),
            5000,
        )
        .await?;
    ctx.fund(&ctx.alice, campaign, 1, 100, None).await?.into_result()?;

    ctx.ff(31).await?;
    ctx.attest(&ctx.alice, campaign, 1, 0).await?.into_result()?;
    ctx.withdraw(&ghost, campaign, 1, 0).await?.into_result()?;

    let cycle = ctx.cycle(campaign, 1).await?;
    assert_eq!(cycle["released"].as_str(), Some("0"), "a failed payout must roll back");
    assert_eq!(cycle["locked"].as_str(), Some("100000000"));
    assert!(!cycle["milestones"][0]["released"].as_bool().unwrap());
    assert_eq!(ctx.balance(ghost.id()).await?, 0);

    ctx.ff(35).await?;
    ctx.finalize(&ctx.alice, campaign, 1).await?.into_result()?;
    let before = ctx.balance(ctx.alice.id()).await?;
    ctx.refund(&ctx.alice, campaign, 1).await?.into_result()?;
    assert_eq!(ctx.balance(ctx.alice.id()).await?, before + 100, "all of it stays refundable");
    Ok(())
}

#[tokio::test]
async fn recurring_cycles_start_empty_and_refund_independently() -> Result<()> {
    let ctx = setup().await?;
    let campaign = ctx.default_campaign().await?;
    ctx.fund(&ctx.alice, campaign, 1, 100, None).await?.into_result()?;

    ctx.ff(31).await?;
    ctx.attest(&ctx.alice, campaign, 1, 0).await?.into_result()?;
    ctx.withdraw(&ctx.creator, campaign, 1, 0).await?.into_result()?;
    ctx.ff(70).await?;
    ctx.finalize(&ctx.alice, campaign, 1).await?.into_result()?;
    ctx.refund(&ctx.alice, campaign, 1).await?.into_result()?;

    assert!(ctx.open_next_cycle(&ctx.alice, campaign).await?.is_failure(), "only the creator opens a cycle");
    ctx.open_next_cycle(&ctx.creator, campaign).await?.into_result()?;

    let cycle2 = ctx.cycle(campaign, 2).await?;
    assert_eq!(cycle2["total_deposited"].as_str(), Some("0"));
    assert!(!cycle2["finalized"].as_bool().unwrap());
    assert_eq!(ctx.cycle(campaign, 1).await?["total_deposited"].as_str(), Some("100000000"));

    // month two is skipped entirely, so the whole pool must come back
    ctx.fund(&ctx.bob, campaign, 2, 80, None).await?.into_result()?;
    ctx.ff(95).await?;
    ctx.finalize(&ctx.bob, campaign, 2).await?.into_result()?;
    let before = ctx.balance(ctx.bob.id()).await?;
    ctx.refund(&ctx.bob, campaign, 2).await?.into_result()?;
    assert_eq!(ctx.balance(ctx.bob.id()).await?, before + 80, "a skipped cycle refunds in full");
    Ok(())
}

#[tokio::test]
async fn campaign_validation_is_enforced_at_creation() -> Result<()> {
    let ctx = setup().await?;
    let before = ctx.balance(ctx.creator.id()).await?;
    let _ = before;

    // weights that do not sum to 10000 bps
    let res = ctx
        .try_create_campaign(
            ctx.creator.id(),
            json!([{"title": "a", "weight_bps": 4000u32, "due_offset_sec": 30u64}]),
            5000,
            20,
        )
        .await?;
    assert!(res.is_failure(), "weights must sum to a whole pool");

    // contribution window outliving the first due date
    let res = ctx
        .try_create_campaign(
            ctx.creator.id(),
            json!([{"title": "a", "weight_bps": 10000u32, "due_offset_sec": 10u64}]),
            5000,
            20,
        )
        .await?;
    assert!(res.is_failure(), "supporters could otherwise fund a milestone already past due");

    // an impossible quorum
    let res = ctx
        .try_create_campaign(
            ctx.creator.id(),
            json!([{"title": "a", "weight_bps": 10000u32, "due_offset_sec": 30u64}]),
            0,
            20,
        )
        .await?;
    assert!(res.is_failure(), "a zero quorum would let one wallet release everything");

    let campaigns = ctx
        .escrow
        .call("list_campaigns")
        .args_json(json!({"from": null, "limit": null}))
        .max_gas()
        .view()
        .await?
        .json::<Vec<u64>>()?;
    assert!(campaigns.is_empty(), "rejected campaigns must not leave state behind");
    Ok(())
}
