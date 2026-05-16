import {
  Contract,
  GlobalState,
  BoxMap,
  Account,
  Uint64,
  bytes,
  Bytes,
  assert,
  itxn,
  Global,
  gtxn,
  uint64,
  clone,
} from '@algorandfoundation/algorand-typescript'
import { abimethod } from '@algorandfoundation/algorand-typescript/arc4'

type EscrowData = {
  merchant: bytes
  amount: uint64
  release_round: uint64
  status: uint64
}

const ESCROW_STATUS_PENDING: uint64 = Uint64(0)
const ESCROW_STATUS_RELEASED: uint64 = Uint64(1)
const ESCROW_STATUS_REFUNDED: uint64 = Uint64(2)

const SETTLEMENT_DELAY_ROUNDS: uint64 = Uint64(1000)

export class MerchantEscrow extends Contract {
  bnpl_app_id = GlobalState<uint64>()
  settlement_delay_rounds = GlobalState<uint64>()
  usdc_asset_id = GlobalState<uint64>()

  escrow_boxes = BoxMap<uint64, EscrowData>({ keyPrefix: '' })

  @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
  public create(): void {}

  @abimethod({ allowActions: ['NoOp', 'OptIn'], onCreate: 'allow' })
  public bootstrap(bnpl_app_id: uint64, usdc_asset_id: uint64): void {
    this.bnpl_app_id.value = bnpl_app_id
    this.settlement_delay_rounds.value = SETTLEMENT_DELAY_ROUNDS
    this.usdc_asset_id.value = usdc_asset_id

    itxn.assetTransfer({
      xferAsset: usdc_asset_id,
      assetReceiver: Global.currentApplicationAddress,
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit()
  }

  @abimethod()
  public create_escrow(
    loan_id: uint64,
    merchant: Account,
    payment: gtxn.AssetTransferTxn
  ): void {
    const usdc: uint64 = this.usdc_asset_id.value
    assert(payment.xferAsset.id === usdc, 'Must send USDC')
    assert(
      payment.assetReceiver.bytes === Global.currentApplicationAddress.bytes,
      'Funds must go to escrow'
    )
    assert(payment.assetAmount > Uint64(0), 'Amount must be > 0')

    const escrow: EscrowData = {
      merchant: merchant.bytes,
      amount: payment.assetAmount,
      release_round: Global.round + this.settlement_delay_rounds.value,
      status: ESCROW_STATUS_PENDING,
    }

    this.escrow_boxes(loan_id).value = clone(escrow)
  }

  @abimethod()
  public release_to_merchant(loan_id: uint64): void {
    const escrow = clone(this.escrow_boxes(loan_id).value)
    assert(escrow.status === ESCROW_STATUS_PENDING, 'Escrow not pending')
    assert(Global.round >= escrow.release_round, 'Settlement period not complete')

    escrow.status = ESCROW_STATUS_RELEASED
    this.escrow_boxes(loan_id).value = clone(escrow)

    itxn.assetTransfer({
      xferAsset: this.usdc_asset_id.value,
      assetReceiver: Account(escrow.merchant),
      assetAmount: escrow.amount,
      fee: Uint64(0),
    }).submit()
  }

  @abimethod()
  public refund_to_borrower(loan_id: uint64, borrower: Account): void {
    const escrow = clone(this.escrow_boxes(loan_id).value)
    assert(escrow.status === ESCROW_STATUS_PENDING, 'Escrow not pending')

    escrow.status = ESCROW_STATUS_REFUNDED
    this.escrow_boxes(loan_id).value = clone(escrow)

    itxn.assetTransfer({
      xferAsset: this.usdc_asset_id.value,
      assetReceiver: borrower,
      assetAmount: escrow.amount,
      fee: Uint64(0),
    }).submit()
  }

  @abimethod({ readonly: true })
  public get_escrow(
    loan_id: uint64
  ): [bytes, uint64, uint64, uint64] {
    if (!this.escrow_boxes(loan_id).exists) {
      return [
        Bytes(''),
        Uint64(0),
        Uint64(0),
        Uint64(0),
      ]
    }

    const escrow = clone(this.escrow_boxes(loan_id).value)
    return [
      escrow.merchant,
      escrow.amount,
      escrow.release_round,
      escrow.status,
    ]
  }
}