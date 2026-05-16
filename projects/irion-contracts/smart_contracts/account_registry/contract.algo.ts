/**
 * Irion B2B — AccountRegistry Contract
 *
 * One-time KYB attestation registry per institution.
 * Maps institution wallet → profile (tier, jurisdiction, approved products,
 * multisig signers, status).
 *
 * Admin = Governance contract address (set at bootstrap).
 * After bootstrap, only the governance multisig can attest KYB or suspend.
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
  op,
} from "@algorandfoundation/algorand-typescript";

// ── Institution tier ──────────────────────────────────────────────────────────
const TIER_DAO: uint64 = Uint64(1);       // DAO / on-chain treasury
const TIER_FINTECH: uint64 = Uint64(2);   // Neobank / payment processor
const TIER_SMB: uint64 = Uint64(3);       // SMB / marketplace

// ── Institution status ────────────────────────────────────────────────────────
const STATUS_PENDING: uint64 = Uint64(0);
const STATUS_APPROVED: uint64 = Uint64(1);
const STATUS_REJECTED: uint64 = Uint64(2);
const STATUS_SUSPENDED: uint64 = Uint64(3);

// ── Approved products bitmask ─────────────────────────────────────────────────
// Bit 0: deposits/withdrawals
// Bit 1: overcollateralized loans
// Bit 2: revolving credit
// Bit 3: term loans
// Bit 4: installment / BNPL-as-a-Service
// Bit 5: FX / swap
// Bit 6: payouts / settlement
const PRODUCT_ALL: uint64 = Uint64(127); // 0b1111111

type InstitutionProfile = {
  kyb_hash: bytes        // SHA-256 of the KYB document bundle (off-chain storage)
  tier: uint64
  jurisdiction: bytes    // ISO 3166-1 alpha-2 country code (e.g. "US", "SG")
  approved_products: uint64  // bitmask
  multisig_threshold: uint64 // M of N required for vault multi-sig releases
  status: uint64
  registered_round: uint64
  last_updated_round: uint64
}

export class AccountRegistry extends Contract {
  governance_address = GlobalState<bytes>()
  institution_count = GlobalState<uint64>()

  profiles = BoxMap<Account, InstitutionProfile>({ keyPrefix: 'i' })

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
  public create(): void {}

  @abimethod({ allowActions: ['NoOp', 'OptIn'], onCreate: 'allow' })
  public bootstrap(governance_address: bytes): void {
    this.governance_address.value = governance_address
    this.institution_count.value = Uint64(0)
  }

  // ── Registration (public — any wallet can self-register) ──────────────────

  /**
   * An institution calls this to register itself and trigger the KYB flow.
   * The kyb_hash is the SHA-256 of the documents bundle stored off-chain
   * (e.g. in IPFS or the API database). The KYB service calls attest_kyb
   * once verification passes.
   *
   * @param kyb_hash   - SHA-256 hash of the KYB document bundle
   * @param tier       - 1=DAO, 2=Fintech, 3=SMB
   * @param jurisdiction - ISO 3166-1 alpha-2 (e.g. Bytes('US'))
   * @param multisig_threshold - required signers for vault multisig (1-10)
   */
  @abimethod()
  public register_institution(
    kyb_hash: bytes,
    tier: uint64,
    jurisdiction: bytes,
    multisig_threshold: uint64
  ): void {
    assert(!this.profiles(Txn.sender).exists, 'Institution already registered')
    assert(tier >= TIER_DAO, 'Invalid tier')
    assert(tier <= TIER_SMB, 'Invalid tier')
    assert(multisig_threshold >= Uint64(1), 'Threshold must be >= 1')
    assert(multisig_threshold <= Uint64(10), 'Threshold must be <= 10')

    const profile: InstitutionProfile = {
      kyb_hash,
      tier,
      jurisdiction,
      approved_products: Uint64(0), // no products until KYB approved
      multisig_threshold,
      status: STATUS_PENDING,
      registered_round: Global.round,
      last_updated_round: Global.round,
    }
    this.profiles(Txn.sender).value = clone(profile)
    this.institution_count.value = this.institution_count.value + Uint64(1)
  }

  // ── KYB Attestation (admin / governance only) ─────────────────────────────

  /**
   * Called by the Didit webhook processor (via the API, via Governance admin)
   * once KYB verification passes. Sets status to APPROVED and grants products.
   *
   * @param institution    - the institution's wallet address
   * @param approved_products - bitmask of approved product flags
   * @param tier           - confirmed tier (may differ from self-declared)
   */
  @abimethod()
  public attest_kyb(
    institution: Account,
    approved_products: uint64,
    tier: uint64
  ): void {
    this.assert_governance()
    assert(this.profiles(institution).exists, 'Institution not registered')

    const profile = clone(this.profiles(institution).value)
    assert(profile.status === STATUS_PENDING, 'Not in pending status')

    profile.status = STATUS_APPROVED
    profile.approved_products = approved_products
    profile.tier = tier
    profile.last_updated_round = Global.round

    this.profiles(institution).value = clone(profile)
  }

  /**
   * Reject a KYB application.
   */
  @abimethod()
  public reject_kyb(institution: Account): void {
    this.assert_governance()
    assert(this.profiles(institution).exists, 'Institution not registered')

    const profile = clone(this.profiles(institution).value)
    profile.status = STATUS_REJECTED
    profile.approved_products = Uint64(0)
    profile.last_updated_round = Global.round

    this.profiles(institution).value = clone(profile)
  }

  /**
   * Suspend an approved institution (e.g. sanctions hit, fraud detection).
   */
  @abimethod()
  public suspend_institution(institution: Account): void {
    this.assert_governance()
    assert(this.profiles(institution).exists, 'Institution not registered')

    const profile = clone(this.profiles(institution).value)
    profile.status = STATUS_SUSPENDED
    profile.approved_products = Uint64(0)
    profile.last_updated_round = Global.round

    this.profiles(institution).value = clone(profile)
  }

  /**
   * Reinstate a suspended institution.
   */
  @abimethod()
  public reinstate_institution(institution: Account, approved_products: uint64): void {
    this.assert_governance()
    assert(this.profiles(institution).exists, 'Institution not registered')

    const profile = clone(this.profiles(institution).value)
    assert(profile.status === STATUS_SUSPENDED, 'Not suspended')

    profile.status = STATUS_APPROVED
    profile.approved_products = approved_products
    profile.last_updated_round = Global.round

    this.profiles(institution).value = clone(profile)
  }

  // ── Read methods ──────────────────────────────────────────────────────────

  @abimethod({ readonly: true })
  public get_profile(
    institution: Account
  ): [bytes, uint64, bytes, uint64, uint64, uint64, uint64, uint64] {
    if (!this.profiles(institution).exists) {
      return [
        Bytes(''),
        Uint64(0),
        Bytes(''),
        Uint64(0),
        Uint64(0),
        STATUS_PENDING,
        Uint64(0),
        Uint64(0),
      ]
    }
    const p = clone(this.profiles(institution).value)
    return [
      p.kyb_hash,
      p.tier,
      p.jurisdiction,
      p.approved_products,
      p.multisig_threshold,
      p.status,
      p.registered_round,
      p.last_updated_round,
    ]
  }

  @abimethod({ readonly: true })
  public is_approved(institution: Account): boolean {
    if (!this.profiles(institution).exists) return false
    return this.profiles(institution).value.status === STATUS_APPROVED
  }

  @abimethod({ readonly: true })
  public has_product(institution: Account, product_bit: uint64): boolean {
    if (!this.profiles(institution).exists) return false
    const profile = clone(this.profiles(institution).value)
    if (profile.status !== STATUS_APPROVED) return false
    return (profile.approved_products & product_bit) !== Uint64(0)
  }

  // ── Admin ─────────────────────────────────────────────────────────────────

  @abimethod()
  public update_governance(new_governance: bytes): void {
    this.assert_governance()
    this.governance_address.value = new_governance
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private assert_governance(): void {
    assert(
      Txn.sender.bytes === this.governance_address.value,
      'Caller is not governance'
    )
  }
}
