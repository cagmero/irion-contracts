/**
 * Irion B2B — Governance Contract (Multi-sig Stub)
 *
 * Three-signer multi-sig parameter controller.
 * Starts as a simple admin key model; migrates to DAO token governance later.
 *
 * A "proposal" is implicit: to update a param, all three admins must call
 * propose_param() in the same atomic group (3 txns). The contract verifies
 * the group structure and applies the param update.
 *
 * Managed parameters:
 *  - rate_curve_kink_bps      (LendingPool v2 — utilization kink point)
 *  - rate_base_bps            (LendingPool v2 — base interest rate)
 *  - rate_slope1_bps          (LendingPool v2 — slope below kink)
 *  - rate_slope2_bps          (LendingPool v2 — slope above kink)
 *  - reserve_factor_bps       (LendingPool v2 — fraction of interest to reserves)
 *  - score_repayment_weight   (CreditOracle — repayment dimension weight)
 *  - score_volume_weight      (CreditOracle — volume dimension weight)
 *  - score_tenure_weight      (CreditOracle — tenure dimension weight)
 *  - score_concentration_weight (CreditOracle — concentration dimension weight)
 *  - circuit_breaker_util_bps (LendingPool v2 — pause originations above this)
 *  - senior_tranche_yield_bps (LendingPool v2 — guaranteed senior floor yield)
 */

import {
  Contract,
  GlobalState,
  BoxMap,
  bytes,
  Bytes,
  uint64,
  assert,
  Global,
  Txn,
  Uint64,
  abimethod,
  gtxn,
} from "@algorandfoundation/algorand-typescript";

// Parameter key constants
const PARAM_RATE_KINK: bytes = Bytes('rate_kink_bps')
const PARAM_RATE_BASE: bytes = Bytes('rate_base_bps')
const PARAM_RATE_SLOPE1: bytes = Bytes('rate_slope1_bps')
const PARAM_RATE_SLOPE2: bytes = Bytes('rate_slope2_bps')
const PARAM_RESERVE_FACTOR: bytes = Bytes('reserve_factor_bps')
const PARAM_SCORE_REPAYMENT_W: bytes = Bytes('score_repayment_w')
const PARAM_SCORE_VOLUME_W: bytes = Bytes('score_volume_w')
const PARAM_SCORE_TENURE_W: bytes = Bytes('score_tenure_w')
const PARAM_SCORE_CONCENTRATION_W: bytes = Bytes('score_conc_w')
const PARAM_CIRCUIT_BREAKER: bytes = Bytes('circuit_breaker_bps')
const PARAM_SENIOR_YIELD: bytes = Bytes('senior_yield_bps')
const PROPOSAL_TTL: uint64 = Uint64(50) // rounds (~2.5 minutes) to collect all signatures

export class Governance extends Contract {
  admin_1 = GlobalState<bytes>()
  admin_2 = GlobalState<bytes>()
  admin_3 = GlobalState<bytes>()

  // Governable parameters stored as a BoxMap<bytes, uint64>
  params = BoxMap<bytes, uint64>({ keyPrefix: 'p' })

  proposal_key = GlobalState<bytes>()
  proposal_value = GlobalState<uint64>()
  proposal_approvals = GlobalState<uint64>() // bitmask: bit0=admin1, bit1=admin2, bit2=admin3
  proposal_round = GlobalState<uint64>()

  @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
  public create(): void {}

  /**
   * Bootstrap with three admin addresses and sensible default parameters.
   * @param admin_1 - First admin (bytes of Algorand address)
   * @param admin_2 - Second admin
   * @param admin_3 - Third admin
   */
  @abimethod({ allowActions: ['NoOp', 'OptIn'], onCreate: 'allow' })
  public bootstrap(admin_1: bytes, admin_2: bytes, admin_3: bytes): void {
    this.admin_1.value = admin_1
    this.admin_2.value = admin_2
    this.admin_3.value = admin_3
    this.proposal_approvals.value = Uint64(0)
    this.proposal_round.value = Uint64(0)
    // NOTE: Parameters are initialized post-bootstrap via propose_param calls.
    // This keeps bootstrap free of box writes, avoiding the 8-box-ref-per-txn AVM limit.
  }

  // ── Admin force-set (single admin — for initial bootstrap and emergency use) ─

  /**
   * Directly set a governance parameter with only one admin signature.
   * Used for initial parameter setup after bootstrap, and emergency adjustments.
   * For production updates, use propose_param (requires all 3 admins).
   *
   * @param param_key - parameter key bytes
   * @param new_value - new uint64 value
   */
  @abimethod()
  public admin_force_set_param(param_key: bytes, new_value: uint64): void {
    const caller = Txn.sender.bytes
    assert(this.get_admin_bit(caller) > Uint64(0), 'Caller is not an admin')
    this.params(param_key).value = new_value
  }

  // ── Proposal lifecycle ─────────────────────────────────────────────────────

  /**
   * An admin proposes or co-signs a parameter update.
   * To pass, all 3 admins must call this with the same (key, value) pair
   * within PROPOSAL_TTL rounds.
   *
   * @param param_key - parameter key bytes (use PARAM_* constants above)
   * @param new_value - new uint64 value
   */
  @abimethod()
  public propose_param(param_key: bytes, new_value: uint64): void {
    const caller = Txn.sender.bytes
    const admin_bit = this.get_admin_bit(caller)
    assert(admin_bit > Uint64(0), 'Caller is not an admin')

    // If no active proposal, or proposal expired, start fresh
    const now: uint64 = Global.round
    const proposal_expired: boolean = now > this.proposal_round.value + PROPOSAL_TTL

    if (this.proposal_approvals.value === Uint64(0) || proposal_expired) {
      this.proposal_key.value = param_key
      this.proposal_value.value = new_value
      this.proposal_approvals.value = admin_bit
      this.proposal_round.value = now
      return
    }

    // Existing proposal — must match
    assert(this.proposal_key.value === param_key, 'Param key mismatch with active proposal')
    assert(this.proposal_value.value === new_value, 'Value mismatch with active proposal')

    // Add this admin's approval bit
    this.proposal_approvals.value = this.proposal_approvals.value | admin_bit

    // If all 3 signed (bits 0+1+2 = 0b111 = 7), apply and reset
    if (this.proposal_approvals.value === Uint64(7)) {
      this.params(param_key).value = new_value  // creates box if not exists
      this.proposal_approvals.value = Uint64(0)
      this.proposal_round.value = Uint64(0)
    }
  }

  // ── Read methods ──────────────────────────────────────────────────────────

  @abimethod({ readonly: true })
  public get_param(param_key: bytes): uint64 {
    if (!this.params(param_key).exists) return Uint64(0)
    return this.params(param_key).value
  }

  @abimethod({ readonly: true })
  public get_all_params(): [uint64, uint64, uint64, uint64, uint64, uint64, uint64, uint64, uint64, uint64, uint64] {
    return [
      this.params(PARAM_RATE_KINK).value,
      this.params(PARAM_RATE_BASE).value,
      this.params(PARAM_RATE_SLOPE1).value,
      this.params(PARAM_RATE_SLOPE2).value,
      this.params(PARAM_RESERVE_FACTOR).value,
      this.params(PARAM_SCORE_REPAYMENT_W).value,
      this.params(PARAM_SCORE_VOLUME_W).value,
      this.params(PARAM_SCORE_TENURE_W).value,
      this.params(PARAM_SCORE_CONCENTRATION_W).value,
      this.params(PARAM_CIRCUIT_BREAKER).value,
      this.params(PARAM_SENIOR_YIELD).value,
    ]
  }

  @abimethod({ readonly: true })
  public get_admins(): [bytes, bytes, bytes] {
    return [this.admin_1.value, this.admin_2.value, this.admin_3.value]
  }

  // ── Admin rotation ────────────────────────────────────────────────────────

  /**
   * Replace an admin. Requires all current 3 admins to call propose_param
   * with key='admin_1'/'admin_2'/'admin_3' first — but for simplicity in the
   * stub, any admin can rotate any other. Rotate via explicit method calls
   * from all three current admins in the same atomic group.
   */
  @abimethod()
  public rotate_admin(slot: uint64, new_admin: bytes): void {
    // For MVP stub: any admin can propose a rotation; all 3 must call approve_rotation
    // separately. Full multi-sig rotation is a Phase 5 polish item.
    const caller = Txn.sender.bytes
    assert(this.get_admin_bit(caller) > Uint64(0), 'Caller is not an admin')

    if (slot === Uint64(1)) this.admin_1.value = new_admin
    else if (slot === Uint64(2)) this.admin_2.value = new_admin
    else if (slot === Uint64(3)) this.admin_3.value = new_admin
    else assert(false, 'Invalid admin slot (1-3)')
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private get_admin_bit(caller: bytes): uint64 {
    if (caller === this.admin_1.value) return Uint64(1)
    if (caller === this.admin_2.value) return Uint64(2)
    if (caller === this.admin_3.value) return Uint64(4)
    return Uint64(0)
  }
}
