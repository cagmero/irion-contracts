# Smart Contract Reference

## LendingPool V2

**File:** `smart_contracts/lending_pool_v2/contract.algo.ts`
**App ID (testnet):** `762889263`

ERC-4626-style lending pool with senior and junior tranches. Accepts deposits of TEST_USDC (Asset 758916950) and issues LP tokens.

### Key Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `create` | `() → void` | Create application |
| `bootstrap` | `(asset_id, ...) → void` | Initialize pool with asset |
| `deposit` | `(tranche: uint64, payment: AssetTransferTxn) → void` | Deposit asset, mint LP tokens |
| `withdraw` | `(tranche: uint64, lp_amount: uint64) → void` | Burn LP tokens, withdraw asset |
| `borrow` | `(amount: uint64, borrower: Account) → uint64` | Borrow from pool (LoanFactory only) |
| `repay` | `(payment: AssetTransferTxn, borrower: bytes) → void` | Repay borrowed amount |
| `get_pool_stats` | `() → [uint64; 6]` | Total deposits, borrows, rates, utilization |
| `get_lender_position` | `(lender: Account) → [uint64; 4]` | Lender's LP balance, deposits, yield |
| `get_current_rate` | `() → uint64` | Current utilization rate in bps |

### Storage

- **BoxMap `l` (prefix):** `lender_positions`, keyed by `Account`, tracks LP token balance, deposits, yield per lender
- **Global state:** Pool stats (total deposits, borrows, utilization, rates), authorized apps (LoanFactory, CreditOracle)

### Fee Pooling

The `deposit` method accepts an `AssetTransferTxn` as a transaction argument. The LendingPool inner txn fee is covered by the outer caller's fee budget (zero inners, no fee pooling needed).

---

## LoanFactory

**File:** `smart_contracts/loan_factory/contract.algo.ts`
**App ID (testnet):** `762889354`

Originates and manages 4 loan types. Each loan has an on-chain record with status, principal, drawn amount, and type-specific parameters.

### Key Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `create` | `() → void` | Create application |
| `bootstrap` | `(...) → void` | Initialize |
| `register_pool` | `(asset_id, pool_app_id) → void` | Register a lending pool for an asset |
| `originate_overcollateralized` | `(borrower, collateral_amount, borrow_amount, ...) → uint64` | Create OC loan (locked via Vault) |
| `originate_revolving` | `(asset_id, initial_draw) → uint64` | Create revolving line |
| `originate_term` | `(asset_id, amount, maturity_rounds) → uint64` | Create term loan |
| `originate_installment` | `(asset_id, amount, installments, ...) → uint64` | Create installment loan |
| `draw` | `(loan_id, amount) → void` | Draw from revolving line |
| `repay` | `(loan_id, payment: AssetTransferTxn) → void` | Repay loan |
| `liquidate` | `(loan_id) → void` | Liquidate overdue loan |
| `get_loan` | `(loan_id) → [bytes; 10]` | Get loan record |
| `get_institution_loans` | `(institution: Account) → uint64[]` | List loan IDs for an institution |

### Loan Status Lifecycle

```
pending → active → repaid
pending → active → overdue → defaulted → liquidated
pending → active → repaid → (closed)
```

### Known Limitation

**`credit_limit=0` for all loan types.** The contract was deployed with `credit_limit=0` in the loan record. The on-chain assertion `assert(new_drawn <= limit)` always fails for REVOLVING draws. The governance bridge path (`borrow` via Governance authority) works and is used by the API for OVERCOLLATERALIZED loans. The `credit_limit` field must be populated in a contract upgrade to enable REVOLVING, TERM, and INSTALLMENT on-chain execution. Tracked in [DEFERRED.md](../../irion-api/DEFERRED.md).

---

## Vault

**File:** `smart_contracts/vault/contract.algo.ts`
**App ID (testnet):** `762889316`

Locks borrower collateral for overcollateralized loans. Each vault entry has a borrower, collateral asset/amount, and release mechanism.

### Key Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `create` | `() → void` | Create application |
| `bootstrap` | `(governance_address, loan_factory_app_id) → void` | Initialize |
| `create_oracle_entry` | `(...) → void` | Create vault entry for OC loan |
| `release` | `(vault_id) → void` | Release collateral on repayment |
| `liquidate` | `(vault_id) → void` | Liquidate (transfer collateral to liquidator) |
| `refund` | `(vault_id) → void` | Refund collateral (loan rejected) |
| `get_entry` | `(vault_id) → [bytes; 9]` | Get vault entry details |

### Storage

- **BoxMap:** Vault entries per `vault_id`, storing borrower, collateral, status, timestamps

---

## CreditOracle

**File:** `smart_contracts/credit_oracle/contract.algo.ts`
**App ID (testnet):** `762892340`

On-chain institutional credit scoring. Maintains a credit profile per institution with repayments, volume, tenure, and composite score.

### Key Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `create` | `() → void` | Create application |
| `create_profile` | `() → void` | Open a credit profile (box) for caller |
| `update_on_borrow` | `(user: Account, amount) → void` | Record borrow event |
| `update_on_repay` | `(user: Account, amount, on_time) → void` | Record repayment |
| `update_on_default` | `(user: Account) → void` | Record default |
| `get_credit_limit` | `(institution: Account, asset_id) → uint64` | Get credit limit |
| `get_composite_score` | `(institution: Account) → uint64` | Get composite score |
| `get_full_profile` | `(...) → [bytes; 8]` | Get full profile |
| `set_weights` | `(...) → void` | Update scoring weights (admin) |

### Known Limitation

**Address convention mismatch.** The LoanFactory passes the borrower address as `Txn.sender` in inner txns to CreditOracle, but CreditOracle expects the institution's Algorand address (the wallet address). This causes the `update_on_repay` CPI to fail for INSTALLMENT loans. Tracked for Phase 3 patching in [DEFERRED.md](../../irion-api/DEFERRED.md#p0--contracts).

---

## Governance

**File:** `smart_contracts/governance/contract.algo.ts`
**App ID (testnet):** `762889174`

Multi-admin authority for cross-contract operations. Currently uses deployer signing as a bridge (single admin). Multisig planned for Phase 3.

### Key Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `create` | `() → void` | Create application |
| `bootstrap` | `(admin_1, admin_2, admin_3) → void` | Set admin addresses |
| `admin_force_set_param` | `(param_key, new_value) → void` | Set param (admin only) |
| `get_param` | `(param_key) → uint64` | Read param |
| `get_admins` | `() → [bytes; 3]` | List current admins |
| `rotate_admins` | `(slot, new_admin) → void` | Replace admin |

---

## AccountRegistry

**File:** `smart_contracts/account_registry/contract.algo.ts`
**App ID (testnet):** `762889254`

Maps institution IDs to on-chain identifiers. Used for cross-contract authorization.

### Key Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `create` | `() → void` | Create application |
| `bootstrap` | `(governance_address) → void` | Initialize |
| `register_institution` | `(...) → void` | Register an institution |
| `attest_kyb` | `(...) → void` | Mark KYB as approved |
| `reject_kyb` | `(institution: Account) → void` | Reject KYB |
| `suspend_institution` | `(institution: Account) → void` | Suspend |
| `reinstate_institution` | `(institution, approved_products) → void` | Reinstate |
| `get_profile` | `(...) → [bytes; N]` | Get institution profile |
| `is_approved` | `(institution: Account) → boolean` | Check approval status |

---

## Contract Architecture

```
                     ┌────────────────┐
                     │  Governance    │
                     │  (authority)   │
                     └───────┬───────┘
                             │
       ┌─────────────────────┼─────────────────────┐
       ▼                     ▼                     ▼
 ┌──────────┐          ┌────────────┐        ┌──────────────┐
 │  Vault   │          │    Loan    │ ←─────▶│  Credit      │
 │          │          │  Factory   │  CPI   │  Oracle      │
 └─────┬────┘          └─────┬──────┘        └──────────────┘
       │                     │
       │  CPI                │  CPI
       ▼                     ▼
 ┌───────────────────────────────────┐
 │         LendingPool V2            │
 │  (senior tranche, junior tranche) │
 └───────────────────────────────────┘
```

The LoanFactory calls Vault to lock/release collateral. When a loan is repaid, LoanFactory CPIs into LendingPool to repay the borrowed amount and CPIs into CreditOracle to update the credit profile. The Governance contract authorizes cross-contract operations (currently deployer-signed, planned for multisig).
