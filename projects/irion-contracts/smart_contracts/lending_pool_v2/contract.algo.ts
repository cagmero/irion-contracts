/**
 * Irion B2B — LendingPool v2 Contract
 *
 * Multi-asset lending pool with:
 *  - Senior / Junior tranches (senior = lower yield, first repaid; junior = higher yield, first-loss)
 *  - Aave-style kinked utilization curve (governable breakpoints)
 *  - LP tokens as transferable ASAs (separate create_assets() call to avoid MBR issues)
 *  - Per-lender accrued yield tracked in Box storage
 *  - Circuit breaker: pauses new borrows above configurable utilization threshold
 *
 * One pool instance per asset (deploy USDC pool + ALGO pool separately).
 * Asset ID = 0 means native ALGO.
 */

import {
  Contract,
  GlobalState,
  BoxMap,
  Account,
  uint64,
  bytes,
  Bytes,
  assert,
  itxn,
  Global,
  Txn,
  Uint64,
  abimethod,
  clone,
  BigUint,
  biguint,
  op,
  gtxn,
} from "@algorandfoundation/algorand-typescript";

// ── Tranche constants ─────────────────────────────────────────────────────────
const TRANCHE_SENIOR: uint64 = Uint64(0)
const TRANCHE_JUNIOR: uint64 = Uint64(1)

// ── BPS constants ─────────────────────────────────────────────────────────────
const BPS: uint64 = Uint64(10000)

// ── Rounds per year (Algorand ~2.85s/block) ──────────────────────────────────
const ROUNDS_PER_YEAR: uint64 = Uint64(11_070_110) // 365*24*3600/2.85

type LenderPosition = {
  deposit_amount: uint64
  tranche: uint64              // TRANCHE_SENIOR or TRANCHE_JUNIOR
  lp_amount: uint64            // LP tokens minted for this position
  accrued_yield: uint64        // accumulated yield not yet withdrawn
  deposit_round: uint64        // round of last yield checkpoint
}

export class LendingPoolV2 extends Contract {
  // ── Governance ─────────────────────────────────────────────────────────────
  governance_address = GlobalState<bytes>()
  credit_oracle_app_id = GlobalState<uint64>()
  loan_factory_app_id = GlobalState<uint64>()

  // ── Pool asset ─────────────────────────────────────────────────────────────
  pool_asset_id = GlobalState<uint64>()  // 0 = native ALGO
  is_native_algo = GlobalState<uint64>() // 1 if ALGO pool

  // ── LP tokens ──────────────────────────────────────────────────────────────
  senior_lp_token_id = GlobalState<uint64>()
  junior_lp_token_id = GlobalState<uint64>()

  // ── Pool state ─────────────────────────────────────────────────────────────
  total_senior_deposits = GlobalState<uint64>()
  total_junior_deposits = GlobalState<uint64>()
  total_borrowed = GlobalState<uint64>()
  total_senior_lp_supply = GlobalState<uint64>()
  total_junior_lp_supply = GlobalState<uint64>()
  reserve_balance = GlobalState<uint64>()
  last_update_round = GlobalState<uint64>()
  circuit_breaker_active = GlobalState<uint64>() // 0=off, 1=on

  // ── Interest rate curve parameters (governable) ────────────────────────────
  rate_base_bps = GlobalState<uint64>()      // base APR in BPS
  rate_slope1_bps = GlobalState<uint64>()    // additional rate at kink
  rate_slope2_bps = GlobalState<uint64>()    // steep slope above kink
  rate_kink_bps = GlobalState<uint64>()      // utilization kink (e.g. 8000 = 80%)
  reserve_factor_bps = GlobalState<uint64>() // fraction of interest to reserves
  circuit_breaker_bps = GlobalState<uint64>()// utilization above which to pause borrows
  senior_yield_floor_bps = GlobalState<uint64>() // guaranteed min yield for senior

  lender_positions = BoxMap<Account, LenderPosition>({ keyPrefix: 'l' })

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
  public create(): void {}

  /**
   * Set pool configuration. Does NOT create LP token ASAs yet (call create_assets() after funding).
   */
  @abimethod({ allowActions: ['NoOp', 'OptIn'], onCreate: 'allow' })
  public bootstrap(
    governance_address: bytes,
    pool_asset_id: uint64,
    rate_base_bps: uint64,
    rate_slope1_bps: uint64,
    rate_slope2_bps: uint64,
    rate_kink_bps: uint64,
    reserve_factor_bps: uint64,
    circuit_breaker_bps: uint64,
    senior_yield_floor_bps: uint64
  ): void {
    this.governance_address.value = governance_address
    this.pool_asset_id.value = pool_asset_id
    this.is_native_algo.value = pool_asset_id === Uint64(0) ? Uint64(1) : Uint64(0)

    this.rate_base_bps.value = rate_base_bps
    this.rate_slope1_bps.value = rate_slope1_bps
    this.rate_slope2_bps.value = rate_slope2_bps
    this.rate_kink_bps.value = rate_kink_bps
    this.reserve_factor_bps.value = reserve_factor_bps
    this.circuit_breaker_bps.value = circuit_breaker_bps
    this.senior_yield_floor_bps.value = senior_yield_floor_bps

    this.total_senior_deposits.value = Uint64(0)
    this.total_junior_deposits.value = Uint64(0)
    this.total_borrowed.value = Uint64(0)
    this.total_senior_lp_supply.value = Uint64(0)
    this.total_junior_lp_supply.value = Uint64(0)
    this.reserve_balance.value = Uint64(0)
    this.circuit_breaker_active.value = Uint64(0)
    this.last_update_round.value = Global.round
    // Must initialize LP token IDs so create_assets can check .value === 0
    this.senior_lp_token_id.value = Uint64(0)
    this.junior_lp_token_id.value = Uint64(0)
    this.loan_factory_app_id.value = Uint64(0)
    this.credit_oracle_app_id.value = Uint64(0)
  }

  /**
   * Create LP token ASAs. Call AFTER funding the app address (MBR: ~0.3 ALGO per token).
   * Creates two ASAs: senior LP token + junior LP token.
   * asset_name_prefix: e.g. "iUSDC" → creates "iUSDC-S-LP" and "iUSDC-J-LP"
   */
  @abimethod()
  public create_assets(asset_name_prefix: bytes): void {
    this.assert_governance()
    assert(this.senior_lp_token_id.value === Uint64(0), 'Assets already created')

    const senior_lp = itxn.assetConfig({
      total: Uint64(1_000_000_000_000_000),
      decimals: Uint64(6),
      unitName: Bytes('S-LP'),
      assetName: op.concat(asset_name_prefix, Bytes('-S-LP')),
      manager: Global.currentApplicationAddress,
      reserve: Global.currentApplicationAddress,
      fee: Uint64(0),
    }).submit()
    this.senior_lp_token_id.value = senior_lp.createdAsset.id

    // Opt the app into the senior LP token
    itxn.assetTransfer({
      xferAsset: this.senior_lp_token_id.value,
      assetReceiver: Global.currentApplicationAddress,
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit()

    const junior_lp = itxn.assetConfig({
      total: Uint64(1_000_000_000_000_000),
      decimals: Uint64(6),
      unitName: Bytes('J-LP'),
      assetName: op.concat(asset_name_prefix, Bytes('-J-LP')),
      manager: Global.currentApplicationAddress,
      reserve: Global.currentApplicationAddress,
      fee: Uint64(0),
    }).submit()
    this.junior_lp_token_id.value = junior_lp.createdAsset.id

    itxn.assetTransfer({
      xferAsset: this.junior_lp_token_id.value,
      assetReceiver: Global.currentApplicationAddress,
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit()

    // Opt into the pool asset (unless ALGO)
    if (this.is_native_algo.value === Uint64(0)) {
      itxn.assetTransfer({
        xferAsset: this.pool_asset_id.value,
        assetReceiver: Global.currentApplicationAddress,
        assetAmount: Uint64(0),
        fee: Uint64(0),
      }).submit()
    }
  }

  // ── Deposit ───────────────────────────────────────────────────────────────

  /**
   * Lend into the pool. Caller must send an asset transfer in the same atomic group.
   * @param tranche    - 0=senior, 1=junior
   * @param payment    - the preceding asset transfer transaction (index in group)
   */
  @abimethod()
  public deposit(tranche: uint64, payment: gtxn.AssetTransferTxn): void {
    assert(this.is_native_algo.value === Uint64(0), 'Use deposit_algo for ALGO pool')
    assert(tranche === TRANCHE_SENIOR || tranche === TRANCHE_JUNIOR, 'Invalid tranche')
    assert(payment.xferAsset.id === this.pool_asset_id.value, 'Wrong asset')
    assert(
      payment.assetReceiver.bytes === Global.currentApplicationAddress.bytes,
      'Asset must go to pool'
    )
    assert(payment.assetAmount > Uint64(0), 'Amount must be > 0')

    this.internal_deposit(Txn.sender, payment.assetAmount, tranche)
  }

  /**
   * Deposit native ALGO (for the ALGO pool only).
   * The ALGO payment is detected via the preceding pay transaction in the group.
   */
  @abimethod()
  public deposit_algo(tranche: uint64, payment: gtxn.PaymentTxn): void {
    assert(this.is_native_algo.value === Uint64(1), 'Use deposit for ASA pool')
    assert(tranche === TRANCHE_SENIOR || tranche === TRANCHE_JUNIOR, 'Invalid tranche')
    assert(
      payment.receiver.bytes === Global.currentApplicationAddress.bytes,
      'ALGO must go to pool'
    )
    assert(payment.amount > Uint64(0), 'Amount must be > 0')

    this.internal_deposit(Txn.sender, payment.amount, tranche)
  }

  // ── Withdraw ──────────────────────────────────────────────────────────────

  /**
   * Burn LP tokens and redeem principal + accrued yield.
   * @param tranche    - must match the depositor's original tranche
   * @param lp_amount  - LP tokens to burn (uint64; caller must have already sent LP tokens back)
   */
  @abimethod()
  public withdraw(tranche: uint64, lp_amount: uint64): void {
    assert(lp_amount > Uint64(0), 'LP amount must be > 0')
    assert(this.lender_positions(Txn.sender).exists, 'No position found')

    this.update_yield(Txn.sender)

    const position = clone(this.lender_positions(Txn.sender).value)
    assert(position.tranche === tranche, 'Tranche mismatch')
    assert(position.lp_amount >= lp_amount, 'Insufficient LP balance')

    // Calculate redemption amount proportional to LP burned
    const total_deposits: uint64 = tranche === TRANCHE_SENIOR
      ? this.total_senior_deposits.value
      : this.total_junior_deposits.value
    const total_lp: uint64 = tranche === TRANCHE_SENIOR
      ? this.total_senior_lp_supply.value
      : this.total_junior_lp_supply.value

    const [high, low] = op.mulw(lp_amount, total_deposits)
    const principal_redemption: uint64 = op.divw(high, low, total_lp)
    const yield_redemption: uint64 = position.accrued_yield

    // Check available liquidity
    const available: uint64 = total_deposits - this.total_borrowed.value
    assert(principal_redemption <= available, 'Insufficient liquidity for withdrawal')

    // Update position
    if (position.lp_amount === lp_amount) {
      this.lender_positions(Txn.sender).delete()
    } else {
      position.lp_amount = position.lp_amount - lp_amount
      position.deposit_amount = position.deposit_amount - principal_redemption
      position.accrued_yield = Uint64(0)
      this.lender_positions(Txn.sender).value = clone(position)
    }

    // Update global state
    if (tranche === TRANCHE_SENIOR) {
      this.total_senior_deposits.value = this.total_senior_deposits.value - principal_redemption
      this.total_senior_lp_supply.value = this.total_senior_lp_supply.value - lp_amount
    } else {
      this.total_junior_deposits.value = this.total_junior_deposits.value - principal_redemption
      this.total_junior_lp_supply.value = this.total_junior_lp_supply.value - lp_amount
    }

    const total_payout: uint64 = principal_redemption + yield_redemption
    this.send_asset(Txn.sender, total_payout)
    this.last_update_round.value = Global.round
  }

  // ── Borrow / Repay ────────────────────────────────────────────────────────

  /**
   * Called by LoanFactory (internal). Sends assets to the borrower.
   * Checks circuit breaker and available liquidity.
   */
  @abimethod()
  public borrow(amount: uint64, borrower: Account): uint64 {
    this.assert_loan_factory()
    assert(this.circuit_breaker_active.value === Uint64(0), 'Circuit breaker: borrowing paused')

    const total_deposits: uint64 = this.total_senior_deposits.value + this.total_junior_deposits.value
    const available: uint64 = total_deposits - this.total_borrowed.value
    assert(amount <= available, 'Insufficient liquidity')

    // Check utilization would not exceed circuit breaker threshold
    const new_borrowed: uint64 = this.total_borrowed.value + amount
    const new_util_bps: uint64 = (new_borrowed * BPS) / total_deposits
    assert(new_util_bps <= this.circuit_breaker_bps.value, 'Would breach circuit breaker')

    this.total_borrowed.value = new_borrowed
    this.send_asset(borrower, amount)
    this.last_update_round.value = Global.round

    return amount
  }

  /**
   * Called by LoanFactory. The asset transfer (repayment) must precede this call.
   * @param payment  - the asset transfer transaction in the atomic group
   * @param borrower - the borrower's address bytes
   */
  @abimethod()
  public repay(payment: gtxn.AssetTransferTxn, borrower: bytes): void {
    this.assert_loan_factory()
    if (this.is_native_algo.value === Uint64(0)) {
      assert(payment.xferAsset.id === this.pool_asset_id.value, 'Wrong repayment asset')
      assert(
        payment.assetReceiver.bytes === Global.currentApplicationAddress.bytes,
        'Repayment must go to pool'
      )
    }
    assert(payment.assetAmount > Uint64(0), 'Repayment must be > 0')

    const repayment = payment.assetAmount
    // Reserve fee
    const [h, l] = op.mulw(repayment, this.reserve_factor_bps.value)
    const reserve_fee = op.divw(h, l, BPS)
    this.reserve_balance.value = this.reserve_balance.value + reserve_fee

    if (this.total_borrowed.value >= repayment) {
      this.total_borrowed.value = this.total_borrowed.value - repayment
    } else {
      this.total_borrowed.value = Uint64(0)
    }

    this.last_update_round.value = Global.round
  }

  // ── Pool stats ─────────────────────────────────────────────────────────────

  @abimethod({ readonly: true })
  public get_pool_stats(): [uint64, uint64, uint64, uint64, uint64, uint64] {
    const total_deposits: uint64 = this.total_senior_deposits.value + this.total_junior_deposits.value
    const util: uint64 = total_deposits > Uint64(0)
      ? (this.total_borrowed.value * BPS) / total_deposits
      : Uint64(0)

    return [
      total_deposits,
      this.total_borrowed.value,
      util,
      this.total_senior_deposits.value,
      this.total_junior_deposits.value,
      this.calculate_interest_rate(util),
    ]
  }

  @abimethod({ readonly: true })
  public get_lender_position(lender: Account): [uint64, uint64, uint64, uint64] {
    if (!this.lender_positions(lender).exists) {
      return [Uint64(0), Uint64(0), Uint64(0), Uint64(0)]
    }
    const pos = clone(this.lender_positions(lender).value)
    return [pos.deposit_amount, pos.tranche, pos.lp_amount, pos.accrued_yield]
  }

  @abimethod({ readonly: true })
  public get_current_rate(): uint64 {
    const total_deposits: uint64 = this.total_senior_deposits.value + this.total_junior_deposits.value
    const util: uint64 = total_deposits > Uint64(0)
      ? (this.total_borrowed.value * BPS) / total_deposits
      : Uint64(0)
    return this.calculate_interest_rate(util)
  }

  // ── Governance ────────────────────────────────────────────────────────────

  @abimethod()
  public set_authorized_apps(loan_factory_app_id: uint64, credit_oracle_app_id: uint64): void {
    this.assert_governance()
    this.loan_factory_app_id.value = loan_factory_app_id
    this.credit_oracle_app_id.value = credit_oracle_app_id
  }

  @abimethod()
  public update_rate_params(
    rate_base_bps: uint64,
    rate_slope1_bps: uint64,
    rate_slope2_bps: uint64,
    rate_kink_bps: uint64,
    reserve_factor_bps: uint64
  ): void {
    this.assert_governance()
    this.rate_base_bps.value = rate_base_bps
    this.rate_slope1_bps.value = rate_slope1_bps
    this.rate_slope2_bps.value = rate_slope2_bps
    this.rate_kink_bps.value = rate_kink_bps
    this.reserve_factor_bps.value = reserve_factor_bps
  }

  @abimethod()
  public toggle_circuit_breaker(active: uint64): void {
    this.assert_governance()
    this.circuit_breaker_active.value = active
  }

  @abimethod()
  public sweep_reserves(recipient: Account): void {
    this.assert_governance()
    const amount = this.reserve_balance.value
    assert(amount > Uint64(0), 'No reserves to sweep')
    this.reserve_balance.value = Uint64(0)
    this.send_asset(recipient, amount)
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private internal_deposit(depositor: Account, amount: uint64, tranche: uint64): void {
    this.update_yield(depositor)

    const total_deposits = tranche === TRANCHE_SENIOR
      ? this.total_senior_deposits.value
      : this.total_junior_deposits.value
    const total_lp = tranche === TRANCHE_SENIOR
      ? this.total_senior_lp_supply.value
      : this.total_junior_lp_supply.value

    const lp_to_mint = this.calculate_lp_tokens(amount, total_deposits, total_lp)

    const existing = this.lender_positions(depositor).exists
      ? clone(this.lender_positions(depositor).value)
      : {
          deposit_amount: Uint64(0),
          tranche,
          lp_amount: Uint64(0),
          accrued_yield: Uint64(0),
          deposit_round: Global.round,
        }

    existing.deposit_amount = existing.deposit_amount + amount
    existing.lp_amount = existing.lp_amount + lp_to_mint
    existing.deposit_round = Global.round
    this.lender_positions(depositor).value = clone(existing)

    if (tranche === TRANCHE_SENIOR) {
      this.total_senior_deposits.value = this.total_senior_deposits.value + amount
      this.total_senior_lp_supply.value = this.total_senior_lp_supply.value + lp_to_mint
      itxn.assetTransfer({
        xferAsset: this.senior_lp_token_id.value,
        assetReceiver: depositor,
        assetAmount: lp_to_mint,
        fee: Uint64(0),
      }).submit()
    } else {
      this.total_junior_deposits.value = this.total_junior_deposits.value + amount
      this.total_junior_lp_supply.value = this.total_junior_lp_supply.value + lp_to_mint
      itxn.assetTransfer({
        xferAsset: this.junior_lp_token_id.value,
        assetReceiver: depositor,
        assetAmount: lp_to_mint,
        fee: Uint64(0),
      }).submit()
    }

    this.last_update_round.value = Global.round
  }

  private update_yield(lender: Account): void {
    if (!this.lender_positions(lender).exists) return
    const pos = clone(this.lender_positions(lender).value)
    const rounds: uint64 = Global.round - pos.deposit_round
    if (rounds === Uint64(0)) return

    const total_deposits: uint64 = this.total_senior_deposits.value + this.total_junior_deposits.value
    const util: uint64 = total_deposits > Uint64(0)
      ? (this.total_borrowed.value * BPS) / total_deposits
      : Uint64(0)
    let rate_bps: uint64 = this.calculate_interest_rate(util)

    // Senior gets floor rate or calculated rate, whichever is less (more conservative)
    if (pos.tranche === TRANCHE_SENIOR) {
      const floor = this.senior_yield_floor_bps.value
      rate_bps = rate_bps < floor ? rate_bps : floor
    }
    // Junior gets full calculated rate (higher risk, higher reward)

    const yield_amt: biguint =
      (BigUint(pos.deposit_amount) * BigUint(rate_bps) * BigUint(rounds)) /
      (BigUint(BPS) * BigUint(ROUNDS_PER_YEAR))

    pos.accrued_yield = pos.accrued_yield + op.btoi(Bytes(yield_amt))
    pos.deposit_round = Global.round
    this.lender_positions(lender).value = clone(pos)
  }

  private calculate_interest_rate(utilization_bps: uint64): uint64 {
    const kink = this.rate_kink_bps.value
    if (utilization_bps <= kink) {
      const [h, l] = op.mulw(this.rate_slope1_bps.value, utilization_bps)
      return this.rate_base_bps.value + op.divw(h, l, kink)
    }
    const excess: uint64 = utilization_bps - kink
    const [h2, l2] = op.mulw(this.rate_slope2_bps.value, excess)
    const steep: uint64 = op.divw(h2, l2, BPS - kink)
    return this.rate_base_bps.value + this.rate_slope1_bps.value + steep
  }

  private calculate_lp_tokens(
    deposit: uint64,
    existing_deposits: uint64,
    existing_lp: uint64
  ): uint64 {
    if (existing_deposits === Uint64(0) || existing_lp === Uint64(0)) return deposit
    const [h, l] = op.mulw(deposit, existing_lp)
    return op.divw(h, l, existing_deposits)
  }

  private send_asset(recipient: Account, amount: uint64): void {
    if (this.is_native_algo.value === Uint64(1)) {
      itxn.payment({
        receiver: recipient,
        amount,
        fee: Uint64(0),
      }).submit()
    } else {
      itxn.assetTransfer({
        xferAsset: this.pool_asset_id.value,
        assetReceiver: recipient,
        assetAmount: amount,
        fee: Uint64(0),
      }).submit()
    }
  }

  private assert_governance(): void {
    assert(
      Txn.sender.bytes === this.governance_address.value,
      'Caller is not governance'
    )
  }

  private assert_loan_factory(): void {
    assert(
      op.Global.callerApplicationId === this.loan_factory_app_id.value ||
      Txn.sender.bytes === this.governance_address.value,
      'Caller is not LoanFactory'
    )
  }
}
