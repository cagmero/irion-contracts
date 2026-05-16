/**
 * Irion B2B — LoanFactory Contract
 *
 * Unified loan origination for all 4 loan types:
 *  0 = OVERCOLLATERALIZED  — Aave-style, collateral locked in Vault before borrow
 *  1 = REVOLVING           — credit line, draw/repay anytime up to CreditOracle limit
 *  2 = TERM                — bullet loan, full repay at maturity
 *  3 = INSTALLMENT         — B2C BNPL flow exposed as B2B primitive
 *
 * All loan state is stored in Box records (not separate apps).
 * Box key format: 'l' + uint64 loan_id (big-endian 8 bytes)
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
  op,
  gtxn,
} from "@algorandfoundation/algorand-typescript";
import { methodSelector } from "@algorandfoundation/algorand-typescript/arc4";

// ── Loan type enum ────────────────────────────────────────────────────────────
const TYPE_OVERCOLLATERALIZED: uint64 = Uint64(0)
const TYPE_REVOLVING: uint64 = Uint64(1)
const TYPE_TERM: uint64 = Uint64(2)
const TYPE_INSTALLMENT: uint64 = Uint64(3)

// ── Loan status enum ──────────────────────────────────────────────────────────
const STATUS_ACTIVE: uint64 = Uint64(0)
const STATUS_COMPLETED: uint64 = Uint64(1)
const STATUS_DEFAULTED: uint64 = Uint64(2)
const STATUS_LIQUIDATED: uint64 = Uint64(3)
const STATUS_DISPUTED: uint64 = Uint64(4)

// ── Constants ─────────────────────────────────────────────────────────────────
const BPS: uint64 = Uint64(10000)
const LATE_FEE_BPS: uint64 = Uint64(200)             // 2% late fee
const INSTALLMENT_INTERVAL: uint64 = Uint64(1576800) // ~30 days in rounds
const DEFAULT_OVERCOLLATERAL_BPS: uint64 = Uint64(15000) // 150% collateral ratio

type LoanRecord = {
  borrower: bytes
  beneficiary: bytes        // merchant (INSTALLMENT) or borrower self
  loan_type: uint64
  pool_app_id: uint64       // which LendingPool v2 to draw from
  asset_id: uint64
  collateral_asset_id: uint64
  collateral_vault_id: uint64  // 0 if no collateral
  principal: uint64
  drawn_amount: uint64      // for REVOLVING: cumulative draws
  credit_limit: uint64      // for REVOLVING: cached from CreditOracle
  total_repaid: uint64
  installment_amount: uint64
  num_installments: uint64
  installments_paid: uint64
  maturity_round: uint64    // for TERM: full repay due by this round
  next_due_round: uint64    // for INSTALLMENT: next payment due
  status: uint64
  origination_round: uint64
  late_fee_bps: uint64
}

export class LoanFactory extends Contract {
  governance_address = GlobalState<bytes>()
  credit_oracle_app_id = GlobalState<uint64>()
  vault_app_id = GlobalState<uint64>()
  loan_counter = GlobalState<uint64>()
  iusdc_asset_id = GlobalState<uint64>()
  circuit_breaker_active = GlobalState<uint64>()

  // pool_app_id per asset: asset_id → pool_app_id
  pool_registry = BoxMap<uint64, uint64>({ keyPrefix: 'r' })

  loans = BoxMap<uint64, LoanRecord>({ keyPrefix: 'l' })
  // institution → array of loan IDs
  institution_loans = BoxMap<Account, uint64[]>({ keyPrefix: 'u' })

  @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
  public create(): void {}

  @abimethod({ allowActions: ['NoOp', 'OptIn'], onCreate: 'allow' })
  public bootstrap(
    governance_address: bytes,
    credit_oracle_app_id: uint64,
    vault_app_id: uint64,
    iusdc_asset_id: uint64
  ): void {
    this.governance_address.value = governance_address
    this.credit_oracle_app_id.value = credit_oracle_app_id
    this.vault_app_id.value = vault_app_id
    this.iusdc_asset_id.value = iusdc_asset_id
    this.loan_counter.value = Uint64(0)
    this.circuit_breaker_active.value = Uint64(0)
  }

  // ── Pool registry ─────────────────────────────────────────────────────────

  @abimethod()
  public register_pool(asset_id: uint64, pool_app_id: uint64): void {
    this.assert_governance()
    this.pool_registry(asset_id).value = pool_app_id
  }

  // ── Loan origination ──────────────────────────────────────────────────────

  /**
   * Originate an OVERCOLLATERALIZED loan.
   * Borrower must first send collateral to Vault (create_oracle_entry).
   *
   * @param asset_id           - asset to borrow (iUSDC asset ID or 0 for ALGO)
   * @param borrow_amount      - amount in asset base units
   * @param collateral_vault_id - vault entry ID holding collateral
   */
  @abimethod()
  public originate_overcollateralized(
    asset_id: uint64,
    borrow_amount: uint64,
    collateral_vault_id: uint64
  ): uint64 {
    assert(this.circuit_breaker_active.value === Uint64(0), 'Circuit breaker active')
    assert(borrow_amount > Uint64(0), 'Amount must be > 0')
    assert(this.pool_registry(asset_id).exists, 'No pool for asset')

    const pool_app_id = this.pool_registry(asset_id).value
    const loan_id = this.next_loan_id()

    const loan: LoanRecord = {
      borrower: Txn.sender.bytes,
      beneficiary: Txn.sender.bytes,
      loan_type: TYPE_OVERCOLLATERALIZED,
      pool_app_id,
      asset_id,
      collateral_asset_id: Uint64(0),
      collateral_vault_id,
      principal: borrow_amount,
      drawn_amount: borrow_amount,
      credit_limit: Uint64(0),
      total_repaid: Uint64(0),
      installment_amount: Uint64(0),
      num_installments: Uint64(0),
      installments_paid: Uint64(0),
      maturity_round: Uint64(0),
      next_due_round: Uint64(0),
      status: STATUS_ACTIVE,
      origination_round: Global.round,
      late_fee_bps: LATE_FEE_BPS,
    }
    this.loans(loan_id).value = clone(loan)
    this.add_institution_loan(Txn.sender, loan_id)

    // Call LendingPool v2 borrow (inner txn)
    this.call_pool_borrow(pool_app_id, borrow_amount, Txn.sender)

    // Update CreditOracle
    this.call_oracle_borrow(Txn.sender, borrow_amount)

    return loan_id
  }

  /**
   * Originate a REVOLVING credit line.
   * CreditOracle determines the credit limit. No collateral required.
   *
   * @param asset_id   - asset for the credit line
   * @param initial_draw - initial draw amount (can be 0 to just open the line)
   */
  @abimethod()
  public originate_revolving(asset_id: uint64, initial_draw: uint64): uint64 {
    assert(this.circuit_breaker_active.value === Uint64(0), 'Circuit breaker active')
    assert(this.pool_registry(asset_id).exists, 'No pool for asset')

    const pool_app_id = this.pool_registry(asset_id).value
    // Credit limit is validated off-chain by the API before this call.
    // On-chain: the pool's circuit breaker and liquidity check guard the borrow.
    const loan_id = this.next_loan_id()

    const loan: LoanRecord = {
      borrower: Txn.sender.bytes,
      beneficiary: Txn.sender.bytes,
      loan_type: TYPE_REVOLVING,
      pool_app_id,
      asset_id,
      collateral_asset_id: Uint64(0),
      collateral_vault_id: Uint64(0),
      principal: initial_draw,
      drawn_amount: initial_draw,
      credit_limit: Uint64(0), // cached off-chain, validated by API
      total_repaid: Uint64(0),
      installment_amount: Uint64(0),
      num_installments: Uint64(0),
      installments_paid: Uint64(0),
      maturity_round: Uint64(0),
      next_due_round: Uint64(0),
      status: STATUS_ACTIVE,
      origination_round: Global.round,
      late_fee_bps: LATE_FEE_BPS,
    }
    this.loans(loan_id).value = clone(loan)
    this.add_institution_loan(Txn.sender, loan_id)

    if (initial_draw > Uint64(0)) {
      this.call_pool_borrow(pool_app_id, initial_draw, Txn.sender)
      this.call_oracle_borrow(Txn.sender, initial_draw)
    }

    return loan_id
  }

  /**
   * Originate a TERM (bullet) loan.
   *
   * @param asset_id       - asset to borrow
   * @param amount         - principal
   * @param maturity_rounds - rounds until full repayment is due
   */
  @abimethod()
  public originate_term(asset_id: uint64, amount: uint64, maturity_rounds: uint64): uint64 {
    assert(this.circuit_breaker_active.value === Uint64(0), 'Circuit breaker active')
    assert(amount > Uint64(0), 'Amount must be > 0')
    assert(maturity_rounds > Uint64(0), 'Maturity must be > 0')
    assert(this.pool_registry(asset_id).exists, 'No pool for asset')

    const pool_app_id = this.pool_registry(asset_id).value
    // Credit limit validated off-chain by the API.
    const loan_id = this.next_loan_id()

    const loan: LoanRecord = {
      borrower: Txn.sender.bytes,
      beneficiary: Txn.sender.bytes,
      loan_type: TYPE_TERM,
      pool_app_id,
      asset_id,
      collateral_asset_id: Uint64(0),
      collateral_vault_id: Uint64(0),
      principal: amount,
      drawn_amount: amount,
      credit_limit: Uint64(0), // cached off-chain, validated by API
      total_repaid: Uint64(0),
      installment_amount: Uint64(0),
      num_installments: Uint64(0),
      installments_paid: Uint64(0),
      maturity_round: Global.round + maturity_rounds,
      next_due_round: Global.round + maturity_rounds,
      status: STATUS_ACTIVE,
      origination_round: Global.round,
      late_fee_bps: LATE_FEE_BPS,
    }
    this.loans(loan_id).value = clone(loan)
    this.add_institution_loan(Txn.sender, loan_id)
    this.call_pool_borrow(pool_app_id, amount, Txn.sender)
    this.call_oracle_borrow(Txn.sender, amount)

    return loan_id
  }

  /**
   * Originate an INSTALLMENT loan (BNPL-as-a-Service).
   *
   * @param asset_id         - asset (iUSDC)
   * @param amount           - purchase principal
   * @param num_installments - number of repayments (1–52)
   * @param beneficiary      - merchant address receiving funds
   */
  @abimethod()
  public originate_installment(
    asset_id: uint64,
    amount: uint64,
    num_installments: uint64,
    beneficiary: Account
  ): uint64 {
    assert(this.circuit_breaker_active.value === Uint64(0), 'Circuit breaker active')
    assert(amount > Uint64(0), 'Amount must be > 0')
    assert(num_installments >= Uint64(1), 'Min 1 installment')
    assert(num_installments <= Uint64(52), 'Max 52 installments')
    assert(this.pool_registry(asset_id).exists, 'No pool for asset')

    const pool_app_id = this.pool_registry(asset_id).value
    // Credit limit validated off-chain by the API.
    const loan_id: uint64 = this.next_loan_id()
    const installment_amount: uint64 = amount / num_installments

    const loan: LoanRecord = {
      borrower: Txn.sender.bytes,
      beneficiary: beneficiary.bytes,
      loan_type: TYPE_INSTALLMENT,
      pool_app_id,
      asset_id,
      collateral_asset_id: Uint64(0),
      collateral_vault_id: Uint64(0),
      principal: amount,
      drawn_amount: amount,
      credit_limit: Uint64(0), // cached off-chain, validated by API
      total_repaid: Uint64(0),
      installment_amount,
      num_installments,
      installments_paid: Uint64(0),
      maturity_round: Uint64(0),
      next_due_round: Global.round + INSTALLMENT_INTERVAL,
      status: STATUS_ACTIVE,
      origination_round: Global.round,
      late_fee_bps: LATE_FEE_BPS,
    }
    this.loans(loan_id).value = clone(loan)
    this.add_institution_loan(Txn.sender, loan_id)

    // Borrow from pool and pay merchant
    this.call_pool_borrow(pool_app_id, amount, beneficiary)
    this.call_oracle_borrow(Txn.sender, amount)

    return loan_id
  }

  // ── Draw (REVOLVING only) ─────────────────────────────────────────────────

  @abimethod()
  public draw(loan_id: uint64, amount: uint64): void {
    const loan = clone(this.loans(loan_id).value)
    assert(loan.status === STATUS_ACTIVE, 'Loan not active')
    assert(loan.loan_type === TYPE_REVOLVING, 'Not a revolving loan')
    assert(Txn.sender.bytes === loan.borrower, 'Not the borrower')

    const new_drawn: uint64 = loan.drawn_amount + amount
    assert(new_drawn <= loan.credit_limit, 'Would exceed credit limit')

    loan.drawn_amount = new_drawn
    this.loans(loan_id).value = clone(loan)

    this.call_pool_borrow(loan.pool_app_id, amount, Txn.sender)
    this.call_oracle_borrow(Txn.sender, amount)
  }

  // ── Repay ─────────────────────────────────────────────────────────────────

  /**
   * Repay any loan type. The asset transfer must precede this call.
   * @param loan_id  - the loan to repay
   * @param payment  - the preceding asset transfer (or pay txn for ALGO)
   */
  @abimethod()
  public repay(loan_id: uint64, payment: gtxn.AssetTransferTxn): void {
    const loan = clone(this.loans(loan_id).value)
    assert(loan.status === STATUS_ACTIVE, 'Loan not active')
    assert(Txn.sender.bytes === loan.borrower, 'Not the borrower')

    if (loan.asset_id > Uint64(0)) {
      assert(payment.xferAsset.id === loan.asset_id, 'Wrong repayment asset')
    }

    const is_on_time = Global.round <= loan.next_due_round

    let effective_amount = payment.assetAmount
    if (!is_on_time && loan.loan_type !== TYPE_REVOLVING) {
      const [h, l] = op.mulw(payment.assetAmount, loan.late_fee_bps)
      const fee = op.divw(h, l, BPS)
      effective_amount = payment.assetAmount + fee
    }

    loan.total_repaid = loan.total_repaid + effective_amount

    if (loan.loan_type === TYPE_INSTALLMENT) {
      loan.installments_paid = loan.installments_paid + Uint64(1)
      if (loan.installments_paid < loan.num_installments) {
        loan.next_due_round = loan.next_due_round + INSTALLMENT_INTERVAL
      }
      if (loan.installments_paid >= loan.num_installments) {
        loan.status = STATUS_COMPLETED
      }
    } else if (loan.loan_type === TYPE_REVOLVING) {
      // Partial repay allowed; reduce drawn_amount
      if (loan.drawn_amount >= effective_amount) {
        loan.drawn_amount = loan.drawn_amount - effective_amount
      } else {
        loan.drawn_amount = Uint64(0)
      }
      if (loan.drawn_amount === Uint64(0)) loan.status = STATUS_COMPLETED
    } else {
      // TERM or OVERCOLLATERALIZED
      if (loan.total_repaid >= loan.principal) {
        loan.status = STATUS_COMPLETED
        // Release collateral vault if applicable
        if (loan.collateral_vault_id > Uint64(0)) {
          this.call_vault_release(loan.collateral_vault_id)
        }
      }
    }

    this.loans(loan_id).value = clone(loan)
    this.call_oracle_repay(Txn.sender, effective_amount, is_on_time)
  }

  // ── Liquidate ─────────────────────────────────────────────────────────────

  @abimethod()
  public liquidate(loan_id: uint64): void {
    const loan = clone(this.loans(loan_id).value)
    assert(loan.status === STATUS_ACTIVE, 'Loan not active')

    if (loan.loan_type === TYPE_INSTALLMENT || loan.loan_type === TYPE_TERM) {
      assert(Global.round > loan.next_due_round, 'Loan not overdue')
    } else if (loan.loan_type === TYPE_REVOLVING) {
      assert(false, 'Revolving loans cannot be liquidated by round')
    }
    // OVERCOLLATERALIZED liquidation is triggered by the API liquidator bot
    // checking the collateral value vs drawn_amount

    loan.status = STATUS_LIQUIDATED
    this.loans(loan_id).value = clone(loan)

    if (loan.collateral_vault_id > Uint64(0)) {
      this.call_vault_liquidate(loan.collateral_vault_id)
    }

    this.call_oracle_default(Txn.sender)
  }

  // ── Read methods ──────────────────────────────────────────────────────────

  @abimethod({ readonly: true })
  public get_loan(loan_id: uint64): [bytes, uint64, uint64, uint64, uint64, uint64, uint64, uint64, uint64, uint64] {
    if (!this.loans(loan_id).exists) {
      return [Bytes(''), Uint64(0), Uint64(0), Uint64(0), Uint64(0), Uint64(0), Uint64(0), Uint64(0), Uint64(0), Uint64(0)]
    }
    const l = clone(this.loans(loan_id).value)
    return [
      l.borrower,
      l.loan_type,
      l.asset_id,
      l.principal,
      l.drawn_amount,
      l.total_repaid,
      l.installments_paid,
      l.num_installments,
      l.next_due_round,
      l.status,
    ]
  }

  @abimethod({ readonly: true })
  public get_institution_loans(institution: Account): uint64[] {
    if (!this.institution_loans(institution).exists) return []
    return this.institution_loans(institution).value
  }

  // ── Governance ────────────────────────────────────────────────────────────

  @abimethod()
  public toggle_circuit_breaker(active: uint64): void {
    this.assert_governance()
    this.circuit_breaker_active.value = active
  }

  @abimethod()
  public update_oracle(credit_oracle_app_id: uint64): void {
    this.assert_governance()
    this.credit_oracle_app_id.value = credit_oracle_app_id
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private next_loan_id(): uint64 {
    const id: uint64 = this.loan_counter.value + Uint64(1)
    this.loan_counter.value = id
    return id
  }

  private add_institution_loan(institution: Account, loan_id: uint64): void {
    if (!this.institution_loans(institution).exists) {
      this.institution_loans(institution).value = [loan_id]
    } else {
      const existing = clone(this.institution_loans(institution).value)
      existing.push(loan_id)
      this.institution_loans(institution).value = clone(existing)
    }
  }

  private read_credit_limit(_institution: Account, _asset_id: uint64): uint64 {
    // Credit limit validation happens off-chain via the API reading the CreditOracle.
    // The contract trusts the API's pre-flight check for MVP.
    // Full on-chain cross-contract reads are scheduled for Phase 3.
    return Uint64(0)
  }

  private call_pool_borrow(pool_app_id: uint64, amount: uint64, recipient: Account): void {
    itxn.applicationCall({
      appId: pool_app_id,
      appArgs: [
        methodSelector('borrow(uint64,address)uint64'),
        op.itob(amount),
        recipient.bytes,
      ],
      fee: Uint64(0),
    }).submit()
  }

  private call_oracle_borrow(institution: Account, amount: uint64): void {
    itxn.applicationCall({
      appId: this.credit_oracle_app_id.value,
      appArgs: [
        methodSelector('update_on_borrow(address,uint64)void'),
        institution.bytes,
        op.itob(amount),
      ],
      fee: Uint64(0),
    }).submit()
  }

  private call_oracle_repay(institution: Account, amount: uint64, on_time: boolean): void {
    itxn.applicationCall({
      appId: this.credit_oracle_app_id.value,
      appArgs: [
        methodSelector('update_on_repay(address,uint64,bool)void'),
        institution.bytes,
        op.itob(amount),
        on_time ? Bytes('\x80') : Bytes('\x00'),
      ],
      fee: Uint64(0),
    }).submit()
  }

  private call_oracle_default(institution: Account): void {
    itxn.applicationCall({
      appId: this.credit_oracle_app_id.value,
      appArgs: [
        methodSelector('update_on_default(address)void'),
        institution.bytes,
      ],
      fee: Uint64(0),
    }).submit()
  }

  private call_vault_release(vault_id: uint64): void {
    itxn.applicationCall({
      appId: this.vault_app_id.value,
      appArgs: [
        methodSelector('release(uint64)void'),
        op.itob(vault_id),
      ],
      fee: Uint64(0),
    }).submit()
  }

  private call_vault_liquidate(vault_id: uint64): void {
    itxn.applicationCall({
      appId: this.vault_app_id.value,
      appArgs: [
        methodSelector('liquidate(uint64)void'),
        op.itob(vault_id),
      ],
      fee: Uint64(0),
    }).submit()
  }

  private assert_governance(): void {
    assert(Txn.sender.bytes === this.governance_address.value, 'Not governance')
  }
}
