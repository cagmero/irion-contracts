import {
  Contract,
  GlobalState,
  BoxMap,
  Account,
  uint64,
  assert,
  Global,
  Txn,
  Uint64,
  abimethod,
  clone,
} from "@algorandfoundation/algorand-typescript";

type CreditProfile = {
  score: uint64
  total_borrowed: uint64
  total_repaid: uint64
  active_loans: uint64
  on_time_repayments: uint64
  late_repayments: uint64
  lending_pool_deposits: uint64
  last_updated_round: uint64
}

const MIN_SCORE: uint64 = Uint64(300)
const MAX_SCORE: uint64 = Uint64(850)

const DEPOSIT_BONUS_PER_10_USDC: uint64 = Uint64(1)
const MAX_DEPOSIT_BONUS: uint64 = Uint64(200)
const ON_TIME_REPAYMENT_BONUS: uint64 = Uint64(20)
const LATE_REPAYMENT_PENALTY: uint64 = Uint64(30)
const DEFAULT_PENALTY: uint64 = Uint64(100)
const NEW_LOAN_PENALTY: uint64 = Uint64(5)

export class CreditScore extends Contract {
  min_score = GlobalState<uint64>()
  max_score = GlobalState<uint64>()
  lending_pool_app_id = GlobalState<uint64>()

  credit_profiles = BoxMap<Account, CreditProfile>({ keyPrefix: 'c' })

  @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
  public create(): void {}

  @abimethod({ allowActions: ['NoOp', 'OptIn'], onCreate: 'allow' })
  public bootstrap(): void {
    this.min_score.value = MIN_SCORE
    this.max_score.value = MAX_SCORE
    this.lending_pool_app_id.value = Uint64(0)
  }

  @abimethod()
  public create_profile(): void {
    const initial_profile: CreditProfile = {
      score: MIN_SCORE,
      total_borrowed: Uint64(0),
      total_repaid: Uint64(0),
      active_loans: Uint64(0),
      on_time_repayments: Uint64(0),
      late_repayments: Uint64(0),
      lending_pool_deposits: Uint64(0),
      last_updated_round: Global.round,
    }
    this.credit_profiles(Txn.sender).value = clone(initial_profile)
  }

  public update_score_on_deposit(user: Account, amount: uint64): void {
    const profile = clone(this.credit_profiles(user).value)

    const deposit_increase: uint64 = amount / Uint64(10_000_000)
    const score_bonus: uint64 = deposit_increase * DEPOSIT_BONUS_PER_10_USDC
    const capped_bonus: uint64 = score_bonus > MAX_DEPOSIT_BONUS ? MAX_DEPOSIT_BONUS : score_bonus

    const new_score: uint64 = this.clamp_score(profile.score + capped_bonus)
    profile.score = new_score
    profile.lending_pool_deposits = profile.lending_pool_deposits + amount
    profile.last_updated_round = Global.round

    this.credit_profiles(user).value = clone(profile)
  }

  public update_score_on_borrow(user: Account, amount: uint64): void {
    const profile = clone(this.credit_profiles(user).value)

    const new_score: uint64 = this.clamp_score(profile.score - NEW_LOAN_PENALTY)
    profile.score = new_score
    profile.total_borrowed = profile.total_borrowed + amount
    profile.active_loans = profile.active_loans + Uint64(1)
    profile.last_updated_round = Global.round

    this.credit_profiles(user).value = clone(profile)
  }

  public update_score_on_repay(user: Account, amount: uint64, on_time: boolean): void {
    const profile = clone(this.credit_profiles(user).value)

    let score_change: uint64 = Uint64(0)
    if (on_time) {
      profile.on_time_repayments = profile.on_time_repayments + Uint64(1)
      score_change = ON_TIME_REPAYMENT_BONUS
    } else {
      profile.late_repayments = profile.late_repayments + Uint64(1)
      score_change = LATE_REPAYMENT_PENALTY
    }

    // Add bonus for on-time, subtract penalty for late
    const new_score: uint64 = on_time 
      ? this.clamp_score(profile.score + score_change)
      : this.clamp_score(profile.score - score_change)
    profile.score = new_score
    profile.total_repaid = profile.total_repaid + amount
    profile.active_loans = profile.active_loans - Uint64(1)
    profile.last_updated_round = Global.round

    this.credit_profiles(user).value = clone(profile)
  }

  public update_score_on_default(user: Account): void {
    const profile = clone(this.credit_profiles(user).value)

    const new_score: uint64 = this.clamp_score(profile.score - DEFAULT_PENALTY)
    profile.score = new_score
    profile.last_updated_round = Global.round

    this.credit_profiles(user).value = clone(profile)
  }

  private clamp_score(score: uint64): uint64 {
    if (score < MIN_SCORE) {
      return MIN_SCORE
    }
    if (score > MAX_SCORE) {
      return MAX_SCORE
    }
    return score
  }

  @abimethod({ readonly: true })
  public get_score(user: Account): uint64 {
    if (!this.credit_profiles(user).exists) {
      return MIN_SCORE
    }
    return this.credit_profiles(user).value.score
  }

  @abimethod({ readonly: true })
  public get_borrow_limit(user: Account): uint64 {
    const score: uint64 = this.get_score(user)

    if (score < Uint64(300)) {
      return Uint64(0)
    }
    if (score < Uint64(350)) {
      return Uint64(10_000_000)       // $10 - New user starter limit
    }
    if (score < Uint64(400)) {
      return Uint64(25_000_000)       // $25 - After 1 on-time repayment
    }
    if (score < Uint64(450)) {
      return Uint64(50_000_000)       // $50 - After 2 on-time repayments
    }
    if (score < Uint64(500)) {
      return Uint64(100_000_000)      // $100 - After 3+ on-time repayments
    }
    if (score < Uint64(600)) {
      return Uint64(500_000_000)      // $500
    }
    if (score < Uint64(700)) {
      return Uint64(2_000_000_000)    // $2,000
    }
    if (score < Uint64(750)) {
      return Uint64(5_000_000_000)    // $5,000
    }
    return Uint64(10_000_000_000)     // $10,000
  }

  @abimethod({ readonly: true })
  public get_credit_profile(
    user: Account
  ): [uint64, uint64, uint64, uint64, uint64, uint64, uint64, uint64] {
    if (!this.credit_profiles(user).exists) {
      return [
        MIN_SCORE,
        Uint64(0),
        Uint64(0),
        Uint64(0),
        Uint64(0),
        Uint64(0),
        Uint64(0),
        Uint64(0),
      ]
    }
    const profile = clone(this.credit_profiles(user).value)
    return [
      profile.score,
      profile.total_borrowed,
      profile.total_repaid,
      profile.active_loans,
      profile.on_time_repayments,
      profile.late_repayments,
      profile.lending_pool_deposits,
      profile.last_updated_round,
    ]
  }

  public set_lending_pool_app(app_id: uint64): void {
    this.lending_pool_app_id.value = app_id
  }
}