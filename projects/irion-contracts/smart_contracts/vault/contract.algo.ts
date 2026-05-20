/**
 * Irion B2B — Vault Contract
 *
 * Generalized collateral and settlement escrow.
 * Handles two use cases:
 *  1. Collateral vault (OVERCOLLATERALIZED loans): holds borrower collateral.
 *     Released when the loan is fully repaid; liquidated if LTV breaches.
 *  2. Pending settlement (BNPL-as-a-Service): holds merchant funds with a
 *     time-lock or multi-sig release condition.
 *
 * Release conditions:
 *  - TIME_LOCK (0): release after release_round
 *  - MULTISIG (1): release after M-of-N approvals
 *  - ORACLE (2): release when LoanFactory calls release (loan fully repaid)
 *
 * Multi-sig approvals: stored as a bitmask (up to 8 signers).
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

// ── Release conditions ────────────────────────────────────────────────────────
const CONDITION_TIME_LOCK: uint64 = Uint64(0)
const CONDITION_MULTISIG: uint64 = Uint64(1)
const CONDITION_ORACLE: uint64 = Uint64(2)   // LoanFactory / Governance triggers

// ── Vault entry status ────────────────────────────────────────────────────────
const STATUS_LOCKED: uint64 = Uint64(0)
const STATUS_RELEASED: uint64 = Uint64(1)
const STATUS_REFUNDED: uint64 = Uint64(2)
const STATUS_LIQUIDATED: uint64 = Uint64(3)

type VaultEntry = {
  owner: bytes              // institution / borrower address
  beneficiary: bytes        // who receives funds on release (merchant or lender pool)
  asset_id: uint64          // 0 = ALGO
  amount: uint64
  collateral_ratio_bps: uint64  // for overcollateralized: LTV threshold (e.g. 15000 = 150%)
  release_condition: uint64    // TIME_LOCK, MULTISIG, or ORACLE
  release_round: uint64        // for TIME_LOCK: round after which release is allowed
  multisig_threshold: uint64   // M of N required
  approvals_bitmask: uint64    // bitmask of signer approvals (up to 8 bits)
  status: uint64
  created_round: uint64
  loan_id: uint64              // linked loan (0 if standalone)
}

export class Vault extends Contract {
  governance_address = GlobalState<bytes>()
  loan_factory_app_id = GlobalState<uint64>()
  vault_counter = GlobalState<uint64>()

  entries = BoxMap<uint64, VaultEntry>({ keyPrefix: 'v' })

  // Signer registry: vault_id → signers (up to 8, stored as concatenated 32-byte addresses)
  signers = BoxMap<uint64, bytes>({ keyPrefix: 's' })

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
  public create(): void {}

  @abimethod({ allowActions: ['NoOp', 'OptIn'], onCreate: 'allow' })
  public bootstrap(governance_address: bytes, loan_factory_app_id: uint64): void {
    this.governance_address.value = governance_address
    this.loan_factory_app_id.value = loan_factory_app_id
    this.vault_counter.value = Uint64(0)
  }

  @abimethod()
  public opt_in_to_asset(asset_id: uint64): void {
    this.assert_governance()
    itxn.assetTransfer({
      xferAsset: asset_id,
      assetReceiver: Global.currentApplicationAddress,
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit()
  }

  // ── Create vault entry ────────────────────────────────────────────────────

  /**
   * Create a TIME_LOCK vault entry (e.g. merchant settlement escrow).
   * The asset transfer must precede this call in the same atomic group.
   */
  @abimethod()
  public create_timelock_entry(
    beneficiary: Account,
    loan_id: uint64,
    release_delay_rounds: uint64,
    payment: gtxn.AssetTransferTxn
  ): uint64 {
    assert(
      payment.assetReceiver.bytes === Global.currentApplicationAddress.bytes,
      'Funds must go to vault'
    )
    assert(payment.assetAmount > Uint64(0), 'Amount must be > 0')

    const vault_id: uint64 = this.vault_counter.value + Uint64(1)
    this.vault_counter.value = vault_id

    const entry: VaultEntry = {
      owner: Txn.sender.bytes,
      beneficiary: beneficiary.bytes,
      asset_id: payment.xferAsset.id,
      amount: payment.assetAmount,
      collateral_ratio_bps: Uint64(0),
      release_condition: CONDITION_TIME_LOCK,
      release_round: Global.round + release_delay_rounds,
      multisig_threshold: Uint64(0),
      approvals_bitmask: Uint64(0),
      status: STATUS_LOCKED,
      created_round: Global.round,
      loan_id,
    }
    this.entries(vault_id).value = clone(entry)
    return vault_id
  }

  /**
   * Create a MULTISIG vault entry (e.g. institutional multi-sig settlement).
   */
  @abimethod()
  public create_multisig_entry(
    beneficiary: Account,
    loan_id: uint64,
    multisig_threshold: uint64,
    signers_concat: bytes,  // 32-byte Algorand addresses concatenated (up to 8 signers)
    payment: gtxn.AssetTransferTxn
  ): uint64 {
    assert(multisig_threshold >= Uint64(1), 'Threshold must be >= 1')
    assert(
      payment.assetReceiver.bytes === Global.currentApplicationAddress.bytes,
      'Funds must go to vault'
    )
    assert(payment.assetAmount > Uint64(0), 'Amount must be > 0')

    const vault_id: uint64 = this.vault_counter.value + Uint64(1)
    this.vault_counter.value = vault_id

    const entry: VaultEntry = {
      owner: Txn.sender.bytes,
      beneficiary: beneficiary.bytes,
      asset_id: payment.xferAsset.id,
      amount: payment.assetAmount,
      collateral_ratio_bps: Uint64(0),
      release_condition: CONDITION_MULTISIG,
      release_round: Uint64(0),
      multisig_threshold,
      approvals_bitmask: Uint64(0),
      status: STATUS_LOCKED,
      created_round: Global.round,
      loan_id,
    }
    this.entries(vault_id).value = clone(entry)
    this.signers(vault_id).value = signers_concat
    return vault_id
  }

  /**
   * Create an ORACLE (LoanFactory-controlled) vault entry for collateral.
   * Only LoanFactory or Governance may call create_oracle_entry.
   */
  @abimethod()
  public create_oracle_entry(
    owner: Account,
    beneficiary: Account,
    loan_id: uint64,
    collateral_ratio_bps: uint64,
    payment: gtxn.AssetTransferTxn
  ): uint64 {
    this.assert_loan_factory_or_governance()
    assert(
      payment.assetReceiver.bytes === Global.currentApplicationAddress.bytes,
      'Funds must go to vault'
    )
    assert(payment.assetAmount > Uint64(0), 'Amount must be > 0')

    const vault_id: uint64 = this.vault_counter.value + Uint64(1)
    this.vault_counter.value = vault_id

    const entry: VaultEntry = {
      owner: owner.bytes,
      beneficiary: beneficiary.bytes,
      asset_id: payment.xferAsset.id,
      amount: payment.assetAmount,
      collateral_ratio_bps,
      release_condition: CONDITION_ORACLE,
      release_round: Uint64(0),
      multisig_threshold: Uint64(0),
      approvals_bitmask: Uint64(0),
      status: STATUS_LOCKED,
      created_round: Global.round,
      loan_id,
    }
    this.entries(vault_id).value = clone(entry)
    return vault_id
  }

  // ── Release / Refund / Liquidate ──────────────────────────────────────────

  /**
   * Release funds to beneficiary.
   * - TIME_LOCK: callable by anyone after release_round
   * - MULTISIG: callable after threshold approvals (bitmask check)
   * - ORACLE: callable only by LoanFactory / Governance
   */
  @abimethod()
  public release(vault_id: uint64): void {
    const entry = clone(this.entries(vault_id).value)
    assert(entry.status === STATUS_LOCKED, 'Vault not locked')

    if (entry.release_condition === CONDITION_TIME_LOCK) {
      assert(Global.round >= entry.release_round, 'Time lock not expired')
    } else if (entry.release_condition === CONDITION_MULTISIG) {
      const approvals = this.count_bits(entry.approvals_bitmask)
      assert(approvals >= entry.multisig_threshold, 'Insufficient approvals')
    } else {
      // CONDITION_ORACLE
      this.assert_loan_factory_or_governance()
    }

    entry.status = STATUS_RELEASED
    this.entries(vault_id).value = clone(entry)
    this.send_from_vault(entry.asset_id, Account(entry.beneficiary), entry.amount)
  }

  /**
   * Refund funds to owner. Only callable by Governance or owner after dispute.
   */
  @abimethod()
  public refund(vault_id: uint64): void {
    const entry = clone(this.entries(vault_id).value)
    assert(entry.status === STATUS_LOCKED, 'Vault not locked')
    assert(
      Txn.sender.bytes === entry.owner || Txn.sender.bytes === this.governance_address.value,
      'Unauthorized'
    )

    entry.status = STATUS_REFUNDED
    this.entries(vault_id).value = clone(entry)
    this.send_from_vault(entry.asset_id, Account(entry.owner), entry.amount)
  }

  /**
   * Liquidate collateral — sends funds to beneficiary (lender pool).
   * Only callable by LoanFactory (triggered by the liquidator bot).
   */
  @abimethod()
  public liquidate(vault_id: uint64): void {
    this.assert_loan_factory_or_governance()
    const entry = clone(this.entries(vault_id).value)
    assert(entry.status === STATUS_LOCKED, 'Vault not locked')
    assert(entry.release_condition === CONDITION_ORACLE, 'Only oracle entries can be liquidated')

    entry.status = STATUS_LIQUIDATED
    this.entries(vault_id).value = clone(entry)
    this.send_from_vault(entry.asset_id, Account(entry.beneficiary), entry.amount)
  }

  /**
   * Multi-sig approval. Caller must be one of the registered signers.
   * Each signer sets their bit in approvals_bitmask.
   */
  @abimethod()
  public approve(vault_id: uint64): void {
    const entry = clone(this.entries(vault_id).value)
    assert(entry.status === STATUS_LOCKED, 'Vault not locked')
    assert(entry.release_condition === CONDITION_MULTISIG, 'Not a multisig vault')

    const signer_idx = this.find_signer_index(vault_id, Txn.sender.bytes)
    assert(signer_idx < Uint64(8), 'Caller is not a registered signer')

    const bit: uint64 = Uint64(1) << signer_idx
    entry.approvals_bitmask = entry.approvals_bitmask | bit
    this.entries(vault_id).value = clone(entry)
  }

  // ── Read methods ──────────────────────────────────────────────────────────

  @abimethod({ readonly: true })
  public get_entry(vault_id: uint64): [bytes, bytes, uint64, uint64, uint64, uint64, uint64, uint64, uint64] {
    if (!this.entries(vault_id).exists) {
      return [Bytes(''), Bytes(''), Uint64(0), Uint64(0), Uint64(0), Uint64(0), Uint64(0), Uint64(0), Uint64(0)]
    }
    const e = clone(this.entries(vault_id).value)
    return [
      e.owner,
      e.beneficiary,
      e.asset_id,
      e.amount,
      e.collateral_ratio_bps,
      e.release_condition,
      e.release_round,
      e.status,
      e.loan_id,
    ]
  }

  // ── Governance ────────────────────────────────────────────────────────────

  @abimethod()
  public update_loan_factory(loan_factory_app_id: uint64): void {
    this.assert_governance()
    this.loan_factory_app_id.value = loan_factory_app_id
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private send_from_vault(asset_id: uint64, recipient: Account, amount: uint64): void {
    if (asset_id === Uint64(0)) {
      itxn.payment({ receiver: recipient, amount, fee: Uint64(0) }).submit()
    } else {
      itxn.assetTransfer({
        xferAsset: asset_id,
        assetReceiver: recipient,
        assetAmount: amount,
        fee: Uint64(0),
      }).submit()
    }
  }

  private count_bits(mask: uint64): uint64 {
    // Unrolled bit count — max 8 signers (8 bits)
    let count: uint64 = Uint64(0)
    let m: uint64 = mask
    if ((m & Uint64(1)) !== Uint64(0)) count = count + Uint64(1)
    m = m >> Uint64(1)
    if ((m & Uint64(1)) !== Uint64(0)) count = count + Uint64(1)
    m = m >> Uint64(1)
    if ((m & Uint64(1)) !== Uint64(0)) count = count + Uint64(1)
    m = m >> Uint64(1)
    if ((m & Uint64(1)) !== Uint64(0)) count = count + Uint64(1)
    m = m >> Uint64(1)
    if ((m & Uint64(1)) !== Uint64(0)) count = count + Uint64(1)
    m = m >> Uint64(1)
    if ((m & Uint64(1)) !== Uint64(0)) count = count + Uint64(1)
    m = m >> Uint64(1)
    if ((m & Uint64(1)) !== Uint64(0)) count = count + Uint64(1)
    m = m >> Uint64(1)
    if ((m & Uint64(1)) !== Uint64(0)) count = count + Uint64(1)
    return count
  }

  private find_signer_index(vault_id: uint64, caller: bytes): uint64 {
    if (!this.signers(vault_id).exists) return Uint64(255)
    const signer_data = this.signers(vault_id).value
    // Each signer is 32 bytes — use op.extract3(value, start, length)
    let i: uint64 = Uint64(0)
    if (op.extract(signer_data, Uint64(0), Uint64(32)) === caller) return i
    i = Uint64(1)
    if (op.extract(signer_data, Uint64(32), Uint64(32)) === caller) return i
    i = Uint64(2)
    if (op.extract(signer_data, Uint64(64), Uint64(32)) === caller) return i
    i = Uint64(3)
    if (op.extract(signer_data, Uint64(96), Uint64(32)) === caller) return i
    i = Uint64(4)
    if (op.extract(signer_data, Uint64(128), Uint64(32)) === caller) return i
    i = Uint64(5)
    if (op.extract(signer_data, Uint64(160), Uint64(32)) === caller) return i
    i = Uint64(6)
    if (op.extract(signer_data, Uint64(192), Uint64(32)) === caller) return i
    i = Uint64(7)
    if (op.extract(signer_data, Uint64(224), Uint64(32)) === caller) return i
    return Uint64(255) // not found
  }

  private assert_governance(): void {
    assert(Txn.sender.bytes === this.governance_address.value, 'Not governance')
  }

  private assert_loan_factory_or_governance(): void {
    assert(
      op.Global.callerApplicationId === this.loan_factory_app_id.value ||
      Txn.sender.bytes === this.governance_address.value,
      'Not authorized'
    )
  }
}
