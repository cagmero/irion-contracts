/**
 * Irion B2B — CreditOracle Contract
 *
 * Multi-dimensional credit scoring system for institutional borrowers.
 * Replaces the B2C CreditScore contract with a richer, governable model.
 *
 * Score dimensions (each 0–1000):
 *  - repayment_score:     on-time payment history
 *  - volume_score:        cumulative borrow/repay volume (log-scaled)
 *  - tenure_score:        wallet age + protocol participation tenure
 *  - concentration_risk:  inverse measure of single-asset borrow concentration
 *
 * Composite score = weighted sum of dimensions (weights are governable).
 * The composite is stored as a cached uint64 (0–1000) and refreshed on each update.
 *
 * Credit limits are derived from the composite score + asset-specific caps.
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
  Global,
  Txn,
  Uint64,
  abimethod,
  clone,
  BigUint,
  biguint,
  op,
} from "@algorandfoundation/algorand-typescript";

type DimensionScores = {
  repayment_score: uint64      // 0–1000: on-time history
  volume_score: uint64         // 0–1000: cumulative volume
  tenure_score: uint64         // 0–1000: wallet/protocol age
  concentration_risk: uint64   // 0–1000: diversification (higher = less concentrated)
  composite_score: uint64      // 0–1000: weighted composite (cached)
  total_borrowed: uint64       // cumulative borrow volume in iUSDC base units
  total_repaid: uint64
  active_loans: uint64
  on_time_repayments: uint64
  late_repayments: uint64
  defaults: uint64
  protocol_tenure_rounds: uint64  // rounds since first interaction
  first_seen_round: uint64
  last_updated_round: uint64
}

// Default weights (sum to 1000 = 100%)
// These are overridable by the Governance contract
const DEFAULT_REPAYMENT_WEIGHT: uint64 = Uint64(400)    // 40%
const DEFAULT_VOLUME_WEIGHT: uint64 = Uint64(250)       // 25%
const DEFAULT_TENURE_WEIGHT: uint64 = Uint64(200)       // 20%
const DEFAULT_CONCENTRATION_WEIGHT: uint64 = Uint64(150) // 15%

const MIN_SCORE: uint64 = Uint64(0)
const MAX_SCORE: uint64 = Uint64(1000)

// Repayment score adjustments
const ON_TIME_BONUS: uint64 = Uint64(15)
const LATE_PENALTY: uint64 = Uint64(25)
const DEFAULT_PENALTY: uint64 = Uint64(120)

// Volume score: points per $100 of cumulative volume (in iUSDC microunits = 6 decimals)
const VOLUME_UNIT: uint64 = Uint64(100_000_000) // $100 in 6-decimal units
const VOLUME_POINTS_PER_UNIT: uint64 = Uint64(10)
const MAX_VOLUME_SCORE: uint64 = Uint64(1000)

// Tenure score: 1 point per ~7 days of participation (7*24*60*60/2.85 ≈ 211754 rounds)
const TENURE_ROUNDS_PER_POINT: uint64 = Uint64(211754)

export class CreditOracle extends Contract {
  governance_address = GlobalState<bytes>()
  loan_factory_app_id = GlobalState<uint64>()
  lending_pool_v2_app_id = GlobalState<uint64>()

  // Governable score weights
  repayment_weight = GlobalState<uint64>()
  volume_weight = GlobalState<uint64>()
  tenure_weight = GlobalState<uint64>()
  concentration_weight = GlobalState<uint64>()

  profiles = BoxMap<Account, DimensionScores>({ keyPrefix: 'c' })

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
  public create(): void {}

  @abimethod({ allowActions: ['NoOp', 'OptIn'], onCreate: 'allow' })
  public bootstrap(
    governance_address: bytes,
    loan_factory_app_id: uint64,
    lending_pool_v2_app_id: uint64
  ): void {
    this.governance_address.value = governance_address
    this.loan_factory_app_id.value = loan_factory_app_id
    this.lending_pool_v2_app_id.value = lending_pool_v2_app_id
    this.repayment_weight.value = DEFAULT_REPAYMENT_WEIGHT
    this.volume_weight.value = DEFAULT_VOLUME_WEIGHT
    this.tenure_weight.value = DEFAULT_TENURE_WEIGHT
    this.concentration_weight.value = DEFAULT_CONCENTRATION_WEIGHT
  }

  // ── Profile creation ──────────────────────────────────────────────────────

  /**
   * Any address can create a profile for itself (one per address).
   * Initial scores are 0; first borrow/repay events build the score.
   */
  @abimethod()
  public create_profile(): void {
    assert(!this.profiles(Txn.sender).exists, 'Profile already exists')

    const profile: DimensionScores = {
      repayment_score: Uint64(0),
      volume_score: Uint64(0),
      tenure_score: Uint64(0),
      concentration_risk: MAX_SCORE, // start at max (not concentrated yet)
      composite_score: Uint64(0),
      total_borrowed: Uint64(0),
      total_repaid: Uint64(0),
      active_loans: Uint64(0),
      on_time_repayments: Uint64(0),
      late_repayments: Uint64(0),
      defaults: Uint64(0),
      protocol_tenure_rounds: Uint64(0),
      first_seen_round: Global.round,
      last_updated_round: Global.round,
    }
    this.profiles(Txn.sender).value = clone(profile)
  }

  // ── Score update methods (all require @abimethod for cross-contract calls) ─

  @abimethod()
  public update_on_deposit(user: Account, amount: uint64): void {
    this.assert_authorized()
    if (!this.profiles(user).exists) return

    const profile = clone(this.profiles(user).value)
    // Deposits boost volume score slightly
    const new_volume: uint64 = profile.total_repaid + amount
    profile.volume_score = this.calculate_volume_score(new_volume)
    profile.last_updated_round = Global.round
    profile.composite_score = this.recalculate_composite(profile)
    this.profiles(user).value = clone(profile)
  }

  @abimethod()
  public update_on_borrow(user: Account, amount: uint64): void {
    this.assert_authorized()
    if (!this.profiles(user).exists) return

    const profile = clone(this.profiles(user).value)
    profile.total_borrowed = profile.total_borrowed + amount
    profile.active_loans = profile.active_loans + Uint64(1)

    // Update tenure
    const rounds_active: uint64 = Global.round - profile.first_seen_round
    profile.protocol_tenure_rounds = rounds_active
    profile.tenure_score = this.calculate_tenure_score(rounds_active)

    profile.last_updated_round = Global.round
    profile.composite_score = this.recalculate_composite(profile)
    this.profiles(user).value = clone(profile)
  }

  @abimethod()
  public update_on_repay(user: Account, amount: uint64, on_time: boolean): void {
    this.assert_authorized()
    if (!this.profiles(user).exists) return

    const profile = clone(this.profiles(user).value)
    profile.total_repaid = profile.total_repaid + amount

    if (profile.active_loans > Uint64(0)) {
      profile.active_loans = profile.active_loans - Uint64(1)
    }

    if (on_time) {
      profile.on_time_repayments = profile.on_time_repayments + Uint64(1)
      const new_score: uint64 = profile.repayment_score + ON_TIME_BONUS
      profile.repayment_score = new_score > MAX_SCORE ? MAX_SCORE : new_score
    } else {
      profile.late_repayments = profile.late_repayments + Uint64(1)
      if (profile.repayment_score >= LATE_PENALTY) {
        profile.repayment_score = profile.repayment_score - LATE_PENALTY
      } else {
        profile.repayment_score = MIN_SCORE
      }
    }

    profile.volume_score = this.calculate_volume_score(profile.total_repaid)
    const rounds_active: uint64 = Global.round - profile.first_seen_round
    profile.tenure_score = this.calculate_tenure_score(rounds_active)
    profile.protocol_tenure_rounds = rounds_active
    profile.last_updated_round = Global.round
    profile.composite_score = this.recalculate_composite(profile)
    this.profiles(user).value = clone(profile)
  }

  @abimethod()
  public update_on_default(user: Account): void {
    this.assert_authorized()
    if (!this.profiles(user).exists) return

    const profile = clone(this.profiles(user).value)
    profile.defaults = profile.defaults + Uint64(1)
    if (profile.active_loans > Uint64(0)) {
      profile.active_loans = profile.active_loans - Uint64(1)
    }
    if (profile.repayment_score >= DEFAULT_PENALTY) {
      profile.repayment_score = profile.repayment_score - DEFAULT_PENALTY
    } else {
      profile.repayment_score = MIN_SCORE
    }
    profile.last_updated_round = Global.round
    profile.composite_score = this.recalculate_composite(profile)
    this.profiles(user).value = clone(profile)
  }

  // ── Credit limit oracle ───────────────────────────────────────────────────

  /**
   * Returns the maximum borrow amount (in iUSDC microunits) for the given
   * institution. Used by LoanFactory before originating a loan.
   *
   * @param institution - the borrowing institution
   * @param asset_id    - the asset being borrowed (0 = ALGO)
   * @returns credit limit in asset base units
   */
  @abimethod({ readonly: true })
  public get_credit_limit(institution: Account, asset_id: uint64): uint64 {
    if (!this.profiles(institution).exists) return Uint64(0)

    const score = this.profiles(institution).value.composite_score

    // Score tiers → USD credit limit (in iUSDC microunits, 6 decimals)
    if (score < Uint64(100)) return Uint64(0)
    if (score < Uint64(200)) return Uint64(10_000_000_000)       // $10,000
    if (score < Uint64(300)) return Uint64(50_000_000_000)       // $50,000
    if (score < Uint64(400)) return Uint64(100_000_000_000)      // $100,000
    if (score < Uint64(500)) return Uint64(250_000_000_000)      // $250,000
    if (score < Uint64(600)) return Uint64(500_000_000_000)      // $500,000
    if (score < Uint64(700)) return Uint64(1_000_000_000_000)    // $1,000,000
    if (score < Uint64(800)) return Uint64(5_000_000_000_000)    // $5,000,000
    return Uint64(10_000_000_000_000)                             // $10,000,000
  }

  // ── Read methods ──────────────────────────────────────────────────────────

  @abimethod({ readonly: true })
  public get_composite_score(institution: Account): uint64 {
    if (!this.profiles(institution).exists) return Uint64(0)
    return this.profiles(institution).value.composite_score
  }

  @abimethod({ readonly: true })
  public get_full_profile(
    institution: Account
  ): [uint64, uint64, uint64, uint64, uint64, uint64, uint64, uint64, uint64, uint64, uint64, uint64] {
    if (!this.profiles(institution).exists) {
      return [
        Uint64(0), Uint64(0), Uint64(0), Uint64(0), Uint64(0),
        Uint64(0), Uint64(0), Uint64(0), Uint64(0), Uint64(0), Uint64(0), Uint64(0),
      ]
    }
    const p = clone(this.profiles(institution).value)
    return [
      p.repayment_score,
      p.volume_score,
      p.tenure_score,
      p.concentration_risk,
      p.composite_score,
      p.total_borrowed,
      p.total_repaid,
      p.active_loans,
      p.on_time_repayments,
      p.late_repayments,
      p.defaults,
      p.protocol_tenure_rounds,
    ]
  }

  // ── Governance methods ────────────────────────────────────────────────────

  @abimethod()
  public set_weights(
    repayment_weight: uint64,
    volume_weight: uint64,
    tenure_weight: uint64,
    concentration_weight: uint64
  ): void {
    this.assert_governance()
    assert(
      repayment_weight + volume_weight + tenure_weight + concentration_weight === Uint64(1000),
      'Weights must sum to 1000'
    )
    this.repayment_weight.value = repayment_weight
    this.volume_weight.value = volume_weight
    this.tenure_weight.value = tenure_weight
    this.concentration_weight.value = concentration_weight
  }

  @abimethod()
  public update_authorized_app(loan_factory_app_id: uint64, lending_pool_v2_app_id: uint64): void {
    this.assert_governance()
    this.loan_factory_app_id.value = loan_factory_app_id
    this.lending_pool_v2_app_id.value = lending_pool_v2_app_id
  }

  // ── Private calculation helpers ───────────────────────────────────────────

  private recalculate_composite(p: DimensionScores): uint64 {
    const rw = this.repayment_weight.value
    const vw = this.volume_weight.value
    const tw = this.tenure_weight.value
    const cw = this.concentration_weight.value

    const weighted: biguint =
      (BigUint(p.repayment_score) * BigUint(rw) +
       BigUint(p.volume_score) * BigUint(vw) +
       BigUint(p.tenure_score) * BigUint(tw) +
       BigUint(p.concentration_risk) * BigUint(cw)) /
      BigUint(1000)

    const composite = op.btoi(Bytes(weighted))
    return composite > MAX_SCORE ? MAX_SCORE : composite
  }

  private calculate_volume_score(cumulative_repaid: uint64): uint64 {
    if (cumulative_repaid === Uint64(0)) return Uint64(0)
    const units: uint64 = cumulative_repaid / VOLUME_UNIT
    const raw: uint64 = units * VOLUME_POINTS_PER_UNIT
    return raw > MAX_VOLUME_SCORE ? MAX_VOLUME_SCORE : raw
  }

  private calculate_tenure_score(rounds_active: uint64): uint64 {
    if (rounds_active === Uint64(0)) return Uint64(0)
    const points: uint64 = rounds_active / TENURE_ROUNDS_PER_POINT
    return points > MAX_SCORE ? MAX_SCORE : points
  }

  private assert_authorized(): void {
    // For MVP: oracle updates are permissioned to governance only.
    // Phase 2+: LoanFactory inner txns use callerApplicationId
    assert(
      Txn.sender.bytes === this.governance_address.value ||
      op.Global.callerApplicationId === this.loan_factory_app_id.value,
      'Unauthorized caller'
    )
  }

  private assert_governance(): void {
    assert(
      Txn.sender.bytes === this.governance_address.value,
      'Caller is not governance'
    )
  }
}
