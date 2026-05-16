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
  gtxn,
  clone,
  op,
} from "@algorandfoundation/algorand-typescript";
import { methodSelector } from '@algorandfoundation/algorand-typescript/arc4'

type LoanData = {
  borrower: bytes
  merchant: bytes
  principal: uint64
  total_repaid: uint64
  installment_amount: uint64
  num_installments: uint64
  installments_paid: uint64
  start_round: uint64
  next_due_round: uint64
  status: uint64
}

const LOAN_STATUS_ACTIVE: uint64 = Uint64(0)
const LOAN_STATUS_COMPLETED: uint64 = Uint64(1)
const LOAN_STATUS_DEFAULTED: uint64 = Uint64(2)
const LOAN_STATUS_DISPUTED: uint64 = Uint64(3)

const LATE_FEE_BPS: uint64 = Uint64(200)
const INSTALLMENT_INTERVAL_ROUNDS: uint64 = Uint64(1576800)

export class BNPLCredit extends Contract {
  credit_score_app_id = GlobalState<uint64>()
  lending_pool_app_id = GlobalState<uint64>()
  loan_counter = GlobalState<uint64>()
  late_fee_bps = GlobalState<uint64>()
  installment_interval = GlobalState<uint64>()
  asset_id = GlobalState<uint64>()

  loan_boxes = BoxMap<uint64, LoanData>({ keyPrefix: 'l' })
  user_loans = BoxMap<Account, uint64[]>({ keyPrefix: 'u' })

  @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
  public create(): void {}

  @abimethod({ allowActions: ['NoOp', 'OptIn'], onCreate: 'allow' })
  public bootstrap(
    credit_score_app_id: uint64,
    lending_pool_app_id: uint64,
    asset_id: uint64
  ): void {
    this.credit_score_app_id.value = credit_score_app_id
    this.lending_pool_app_id.value = lending_pool_app_id
    this.asset_id.value = asset_id
    this.loan_counter.value = Uint64(0)
    this.late_fee_bps.value = LATE_FEE_BPS
    this.installment_interval.value = INSTALLMENT_INTERVAL_ROUNDS
  }

  @abimethod()
  public opt_in_to_asset(asset: uint64): void {
    itxn.assetTransfer({
      xferAsset: asset,
      assetAmount: Uint64(0),
      assetReceiver: Global.currentApplicationAddress,
      fee: Uint64(0)
    }).submit()
  }

  @abimethod()
  public initiate_loan(
    merchant: Account,
    amount: uint64,
    num_installments: uint64
  ): uint64 {
    assert(amount > Uint64(0), 'Amount must be > 0')
    assert(num_installments > Uint64(0), 'Installments must be > 0')
    assert(num_installments <= Uint64(52), 'Max 52 installments')

    const lending_pool_app: uint64 = this.lending_pool_app_id.value
    assert(lending_pool_app > Uint64(0), 'Lending pool not set')

    const borrow_selector = methodSelector('borrow(uint64,address)uint64')
    itxn.applicationCall({
      appId: lending_pool_app,
      appArgs: [
        borrow_selector,
        Bytes(amount),
        Txn.sender.bytes,
      ],
      fee: Uint64(0),
    }).submit()

    const new_loan_id: uint64 = this.loan_counter.value + Uint64(1)
    this.loan_counter.value = new_loan_id

    const installment_amount: uint64 = amount / num_installments

    const loan: LoanData = {
      borrower: Txn.sender.bytes,
      merchant: merchant.bytes,
      principal: amount,
      total_repaid: Uint64(0),
      installment_amount,
      num_installments,
      installments_paid: Uint64(0),
      start_round: Global.round,
      next_due_round: Global.round + this.installment_interval.value,
      status: LOAN_STATUS_ACTIVE,
    }

    this.loan_boxes(new_loan_id).value = clone(loan)

    if (!this.user_loans(Txn.sender).exists) {
      this.user_loans(Txn.sender).value = [new_loan_id]
    } else {
      const existing_loans = clone(this.user_loans(Txn.sender).value)
      existing_loans.push(new_loan_id)
      this.user_loans(Txn.sender).value = clone(existing_loans)
    }

    return new_loan_id
  }

  @abimethod()
  public make_payment(loan_id: uint64, payment: gtxn.AssetTransferTxn): void {
    const loan = clone(this.loan_boxes(loan_id).value)
    assert(loan.status === LOAN_STATUS_ACTIVE, 'Loan not active')
    assert(
      payment.sender.bytes === loan.borrower,
      'Payment must be from borrower'
    )

    assert(payment.xferAsset.id === this.asset_id.value, 'Must pay with pool asset')

    const payment_round: uint64 = Global.round
    const is_on_time: boolean = payment_round <= loan.next_due_round

    if (is_on_time) {
      loan.total_repaid = loan.total_repaid + payment.assetAmount
      loan.installments_paid = loan.installments_paid + Uint64(1)

      if (loan.installments_paid >= loan.num_installments) {
        loan.status = LOAN_STATUS_COMPLETED
        const repay_selector = methodSelector('repay(asset_transfer,address)')
        itxn.applicationCall({
          appId: this.lending_pool_app_id.value,
          appArgs: [repay_selector, Bytes(payment.assetAmount), loan.borrower],
          fee: Uint64(0),
        }).submit()
      } else {
        loan.next_due_round = loan.next_due_round + this.installment_interval.value
      }
    } else {
      const [high, low] = op.mulw(payment.assetAmount, this.late_fee_bps.value)
      const late_fee: uint64 = op.divw(high, low, Uint64(10000))
      const total_payment: uint64 = payment.assetAmount + late_fee

      loan.total_repaid = loan.total_repaid + total_payment
      loan.installments_paid = loan.installments_paid + Uint64(1)

      if (loan.installments_paid >= loan.num_installments) {
        loan.status = LOAN_STATUS_COMPLETED
        const repay_selector = methodSelector('repay(asset_transfer,address)')
        itxn.applicationCall({
          appId: this.lending_pool_app_id.value,
          appArgs: [repay_selector, Bytes(total_payment), loan.borrower],
          fee: Uint64(0),
        }).submit()
      } else {
        loan.next_due_round = loan.next_due_round + this.installment_interval.value
      }
    }

    this.loan_boxes(loan_id).value = clone(loan)
  }

  @abimethod()
  public dispute_loan(loan_id: uint64): void {
    const loan = clone(this.loan_boxes(loan_id).value)
    assert(loan.status === LOAN_STATUS_ACTIVE, 'Loan not active')
    assert(
      Txn.sender.bytes === loan.borrower,
      'Only borrower can dispute'
    )

    loan.status = LOAN_STATUS_DISPUTED
    this.loan_boxes(loan_id).value = clone(loan)
  }

  @abimethod()
  public liquidate_loan(loan_id: uint64): void {
    const loan = clone(this.loan_boxes(loan_id).value)
    assert(loan.status === LOAN_STATUS_ACTIVE, 'Loan not active')

    assert(Global.round >= loan.next_due_round, 'Loan not overdue')

    loan.status = LOAN_STATUS_DEFAULTED
    this.loan_boxes(loan_id).value = clone(loan)

    const default_selector = methodSelector('update_score_on_default(address)')
    itxn.applicationCall({
      appId: this.credit_score_app_id.value,
      appArgs: [default_selector, loan.borrower],
      fee: Uint64(0),
    }).submit()
  }

  @abimethod({ readonly: true })
  public get_loan(
    loan_id: uint64
  ): [bytes, bytes, uint64, uint64, uint64, uint64, uint64, uint64, uint64] {
    if (!this.loan_boxes(loan_id).exists) {
      return [
        Bytes(''),
        Bytes(''),
        Uint64(0),
        Uint64(0),
        Uint64(0),
        Uint64(0),
        Uint64(0),
        Uint64(0),
        Uint64(0),
      ]
    }

    const loan = clone(this.loan_boxes(loan_id).value)
    return [
      loan.borrower,
      loan.merchant,
      loan.principal,
      loan.total_repaid,
      loan.installment_amount,
      loan.num_installments,
      loan.installments_paid,
      loan.next_due_round,
      loan.status,
    ]
  }

  @abimethod({ readonly: true })
  public get_user_loans(user: Account): uint64[] {
    if (!this.user_loans(user).exists) {
      return []
    }
    return this.user_loans(user).value
  }
}