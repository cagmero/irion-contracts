import {
  Contract,
  GlobalState,
  BoxMap,
  Bytes,
  itxn,
  uint64,
  Global,
  assert,
  abimethod,
  Txn,
  Uint64,
  bytes,
  Account,
  gtxn,
  Application,
  clone,
  op,
  BigUint,
  biguint,
} from "@algorandfoundation/algorand-typescript";

type LenderPosition = {
  deposit_amount: uint64
  deposit_round: uint64
  accrued_yield: uint64
}

const SECONDS_PER_YEAR: uint64 = Uint64(31536000)
const BPS_MULTIPLIER: uint64 = Uint64(10000)
const UTILIZATION_SLOPE: uint64 = Uint64(800)
const MAX_UTILIZATION: uint64 = Uint64(9500)

export class LendingPool extends Contract {
  total_deposits = GlobalState<uint64>()
  total_borrowed = GlobalState<uint64>()
  reserve_factor = GlobalState<uint64>()
  interest_rate_base = GlobalState<uint64>()
  pool_asset_id = GlobalState<uint64>()
  lp_token_id = GlobalState<uint64>()
  total_lp_supply = GlobalState<uint64>()
  last_update_round = GlobalState<uint64>()

  lender_boxes = BoxMap<Account, LenderPosition>({ keyPrefix: 'l' })

  credit_score_app_id = GlobalState<uint64>()

  @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
  public create(): void {}

  @abimethod({ allowActions: ['NoOp', 'OptIn'], onCreate: 'allow' })
  public bootstrap(pool_asset_id: uint64): void {
    this.pool_asset_id.value = pool_asset_id

    const create_lp_token = itxn.assetConfig({
      total: Uint64(1_000_000_000_000),
      decimals: Uint64(6),
      unitName: 'LPC',
      assetName: 'Irion LP',
      manager: Global.currentApplicationAddress,
      reserve: Global.currentApplicationAddress,
      fee: Uint64(0),
    }).submit()

    this.lp_token_id.value = create_lp_token.createdAsset.id
    
    itxn.assetTransfer({
      xferAsset: this.lp_token_id.value,
      assetReceiver: Global.currentApplicationAddress,
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit()

    itxn.assetTransfer({
      xferAsset: this.pool_asset_id.value,
      assetReceiver: Global.currentApplicationAddress,
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit()

    this.total_deposits.value = Uint64(0)
    this.total_borrowed.value = Uint64(0)
    this.total_lp_supply.value = Uint64(0)
    this.reserve_factor.value = Uint64(1000)
    this.interest_rate_base.value = Uint64(500)
    this.last_update_round.value = Global.round
  }

  @abimethod()
  public deposit(payment: gtxn.AssetTransferTxn): void {
    assert(
      payment.xferAsset.id === this.pool_asset_id.value,
      'Asset must be the pool asset'
    )
    assert(
      payment.assetReceiver.bytes === Global.currentApplicationAddress.bytes,
      'Asset must be received by the pool'
    )
    assert(payment.assetAmount > Uint64(0), 'Deposit amount must be > 0')

    this.update_accrued_yield(Txn.sender)

    const current_position = this.lender_boxes(Txn.sender).exists
      ? this.lender_boxes(Txn.sender).value
      : { deposit_amount: Uint64(0), deposit_round: Global.round, accrued_yield: Uint64(0) }

    const deposit_amount: uint64 = current_position.deposit_amount + payment.assetAmount
    const deposit_round: uint64 = Global.round

    this.lender_boxes(Txn.sender).value = {
      deposit_amount,
      deposit_round,
      accrued_yield: current_position.accrued_yield,
    }

    const lp_tokens_to_mint: uint64 = this.calculate_lp_tokens(
      payment.assetAmount,
      this.total_deposits.value,
      this.total_lp_supply.value
    )

    itxn.assetTransfer({
      xferAsset: this.lp_token_id.value,
      assetReceiver: Txn.sender,
      assetAmount: lp_tokens_to_mint,
      fee: Uint64(0),
    }).submit()

    this.total_deposits.value = this.total_deposits.value + payment.assetAmount
    this.total_lp_supply.value = this.total_lp_supply.value + lp_tokens_to_mint
    this.last_update_round.value = Global.round
  }

  private calculate_lp_tokens(
    deposit_amount: uint64,
    existing_deposits: uint64,
    existing_lp_supply: uint64
  ): uint64 {
    if (existing_deposits === Uint64(0) || existing_lp_supply === Uint64(0)) {
      return deposit_amount
    }

    const [high, low] = op.mulw(deposit_amount, existing_lp_supply)
    return op.divw(high, low, existing_deposits)
  }

  @abimethod()
  public withdraw(lp_amount: uint64): void {
    assert(lp_amount > Uint64(0), 'LP amount must be > 0')

    const position = clone(this.lender_boxes(Txn.sender).value)
    assert(position.deposit_amount > Uint64(0), 'No deposit found')

    this.update_accrued_yield(Txn.sender)

    const updated_position = clone(this.lender_boxes(Txn.sender).value)
    const yield_earned: uint64 = updated_position.accrued_yield
    const total_withdrawal: uint64 = updated_position.deposit_amount + yield_earned

    this.lender_boxes(Txn.sender).delete()

    this.total_deposits.value = this.total_deposits.value - updated_position.deposit_amount
    this.total_lp_supply.value = this.total_lp_supply.value - lp_amount

    itxn.assetTransfer({
      xferAsset: this.pool_asset_id.value,
      assetReceiver: Txn.sender,
      assetAmount: total_withdrawal,
      fee: Uint64(0),
    }).submit()

    this.last_update_round.value = Global.round
  }

  @abimethod()
  public borrow(amount: uint64, borrower: Account): uint64 {
    const pool_asset: uint64 = this.pool_asset_id.value

    const available: uint64 = this.total_deposits.value - this.total_borrowed.value
    assert(amount <= available, 'Insufficient liquidity')

    this.total_borrowed.value = this.total_borrowed.value + amount

    itxn.assetTransfer({
      xferAsset: pool_asset,
      assetReceiver: borrower,
      assetAmount: amount,
      fee: Uint64(0),
    }).submit()

    return amount
  }

  @abimethod()
  public repay(payment: gtxn.AssetTransferTxn, borrower: bytes): void {
    const pool_asset: uint64 = this.pool_asset_id.value
    assert(
      payment.xferAsset.id === pool_asset,
      'Asset must be the pool asset'
    )
    assert(
      payment.assetReceiver.bytes === Global.currentApplicationAddress.bytes,
      'Asset must be received by pool'
    )
    assert(payment.assetAmount > Uint64(0), 'Repayment amount must be > 0')

    this.total_borrowed.value = this.total_borrowed.value - payment.assetAmount

    const reserve_fee: uint64 = (payment.assetAmount * this.reserve_factor.value) / BPS_MULTIPLIER
  }

  private update_accrued_yield(lender: Account): void {
    const key = this.lender_boxes(lender)
    if (!key.exists) {
      return
    }

    const position = clone(key.value)
    const rounds_elapsed: uint64 = Global.round - position.deposit_round

    if (rounds_elapsed === Uint64(0)) {
      return
    }

    const current_rate: uint64 = this.calculate_current_interest_rate()
    const yield_earned: uint64 = this.calculate_yield(
      position.deposit_amount,
      current_rate,
      rounds_elapsed
    )

    position.accrued_yield = position.accrued_yield + yield_earned
    position.deposit_round = Global.round
    key.value = clone(position)
  }

  private calculate_current_interest_rate(): uint64 {
    const utilization: uint64 = this.calculate_utilization()
    const rate: uint64 = this.interest_rate_base.value +
      ((utilization * UTILIZATION_SLOPE) / BPS_MULTIPLIER)
    return rate
  }

  private calculate_utilization(): uint64 {
    if (this.total_deposits.value === Uint64(0)) {
      return Uint64(0)
    }
    return (this.total_borrowed.value * BPS_MULTIPLIER) / this.total_deposits.value
  }

  private calculate_yield(
    deposit_amount: uint64,
    annual_rate: uint64,
    rounds_elapsed: uint64
  ): uint64 {
    const rounds_per_year: uint64 = Uint64(1576800)
    const yield_amount: biguint = (BigUint(deposit_amount) * BigUint(annual_rate) * BigUint(rounds_elapsed)) /
      (BigUint(BPS_MULTIPLIER) * BigUint(rounds_per_year))
    return op.btoi(Bytes(yield_amount))
  }

  @abimethod({ readonly: true })
  public get_pool_stats(): [uint64, uint64, uint64] {
    return [
      this.total_deposits.value,
      this.total_borrowed.value,
      this.calculate_utilization(),
    ]
  }

  @abimethod({ readonly: true })
  public get_lender_position(lender: Account): [uint64, uint64] {
    if (!this.lender_boxes(lender).exists) {
      return [Uint64(0), Uint64(0)]
    }
    const position = clone(this.lender_boxes(lender).value)
    return [position.deposit_amount, position.accrued_yield]
  }

  public set_credit_score_app(app_id: uint64): void {
    this.credit_score_app_id.value = app_id
  }
}