# Irion Network — Smart Contracts

> Six PuyaTS smart contracts powering the Irion B2B Neobank API on Algorand Testnet.
>
> All contracts written in [Algorand TypeScript (PuyaTS)](https://github.com/algorandfoundation/puya-ts), compiled to TEAL via the Puya compiler. Deployed, verified, and patched during Phase 2 build.

---

## Table of Contents

- [Architecture](#architecture)
- [Contracts](#contracts)
- [Contract Interactions](#contract-interactions)
- [Storage Model](#storage-model)
- [Patches Applied During Phase 2](#patches-applied-during-phase-2)
- [Known Limitations](#known-limitations)
- [Build + Deploy](#build--deploy)
- [Testing](#testing)
- [Phase 3 Roadmap](#phase-3-roadmap)
- [License](#license)

---

## Architecture

```
                      ┌─────────────────┐
                      │   Governance    │
                      │  (762889174)    │
                      │  (multisig in   │
                      │   Phase 3)      │
                      └───────┬─────────┘
                              │ authority
        ┌─────────────────────┼────────────────────┐
        ▼                     ▼                    ▼
  ┌──────────┐          ┌────────────┐       ┌──────────────┐
  │  Vault   │          │    Loan    │ ←────▶│  Credit      │
  │(762889316)│         │  Factory   │  CPI  │  Oracle      │
  │          │          │(762889354) │       │ (762892340)  │
  └─────┬────┘          └─────┬──────┘       └──────────────┘
        │                     │  CPI
        │                     ▼
        │               ┌────────────┐
        │  collateral   │  Lending   │
        └──────────────▶│   Pool V2  │
                        │ (762889263)│
                        │ (senior +  │
                        │  junior)   │
                        └────────────┘
```

### Cross-Contract Call Flow

1. **LoanFactory** originates loans → calls **Vault** to lock collateral (OC loans) and **LendingPool** to borrow funds
2. **LoanFactory** repays → sends assets to **LendingPool**, calls **CreditOracle** to update credit profile
3. **Governance** authorizes cross-contract operations (Vault entry creation, CreditOracle updates)
4. **LendingPool** manages LP token minting/burning for deposits and withdrawals

---

## Contracts

### LendingPool V2

ERC-4626-style lending pool with senior and junior tranches. Senior tranche reserved for institutional lenders (lower yield, first repaid in liquidation). Junior tranche reserved for risk-seeking liquidity providers (higher yield, bears first loss).

| Field | Value |
|-------|-------|
| **App ID (testnet)** | `762889263` |
| **Lora Explorer** | [view](https://lora.algokit.io/testnet/application/762889263) |
| **Source** | [`smart_contracts/lending_pool_v2/contract.algo.ts`](./projects/irion-contracts/smart_contracts/lending_pool_v2/contract.algo.ts) |
| **Senior LP Token (ASA)** | `762889282` ([view](https://lora.algokit.io/testnet/asset/762889282)) |
| **Junior LP Token (ASA)** | `762889284` ([view](https://lora.algokit.io/testnet/asset/762889284)) |

**Key methods:** `deposit`, `withdraw`, `borrow`, `repay`, `get_pool_stats`, `get_lender_position`, `get_current_rate`

**Storage:**
- `BoxMap<Account, LenderPosition>` prefix `l` — per-lender position (LP balance, deposits, yield)
- Global state — pool totals, utilization rate, interest params, authorized apps

### LoanFactory

Originates and manages 4 loan types. Each loan is identified by an on-chain counter and stored in a Box.

| Field | Value |
|-------|-------|
| **App ID (testnet)** | `762889354` |
| **Lora Explorer** | [view](https://lora.algokit.io/testnet/application/762889354) |
| **Source** | [`smart_contracts/loan_factory/contract.algo.ts`](./projects/irion-contracts/smart_contracts/loan_factory/contract.algo.ts) |

**Key methods:**

| Method | Description |
|--------|-------------|
| `originate_overcollateralized` | Lock collateral in Vault, borrow from pool via Governance |
| `originate_revolving` | Open revolving credit line (on-chain draw after origination) |
| `originate_term` | Fixed principal, fixed maturity, interest on repayment |
| `originate_installment` | Amortized schedule with equal installments |
| `draw` | Draw additional funds from revolving line |
| `repay` | Repay via asset transfer + CreditOracle update |
| `liquidate` | Trigger liquidation on overdue loan |
| `get_loan` | Read loan record by ID |
| `get_institution_loans` | List all loan IDs for an institution |

**Loan status lifecycle:**
```
pending → active → repaid
pending → active → overdue → defaulted → liquidated
```

### Vault

Locks borrower collateral for overcollateralized loans. Supports multiple vault entry types: timelock, multisig, and oracle-based release.

| Field | Value |
|-------|-------|
| **App ID (testnet)** | `762889316` |
| **Lora Explorer** | [view](https://lora.algokit.io/testnet/application/762889316) |
| **Source** | [`smart_contracts/vault/contract.algo.ts`](./projects/irion-contracts/smart_contracts/vault/contract.algo.ts) |

**Key methods:** `create_timelock_entry`, `create_multisig_entry`, `create_oracle_entry`, `release`, `liquidate`, `refund`, `get_entry`

### CreditOracle

On-chain institutional credit scoring. Maintains a Box-based credit profile per institution with total borrowed, total repaid, default count, and multi-factor composite score.

| Field | Value |
|-------|-------|
| **App ID (testnet)** | `762892340` |
| **Lora Explorer** | [view](https://lora.algokit.io/testnet/application/762892340) |
| **Source** | [`smart_contracts/credit_oracle/contract.algo.ts`](./projects/irion-contracts/smart_contracts/credit_oracle/contract.algo.ts) |

**Key methods:** `create_profile`, `update_on_borrow`, `update_on_repay`, `update_on_default`, `get_credit_limit`, `get_composite_score`, `get_full_profile`

**Score factors:** repayment history, volume, tenure, concentration risk → composite score 300–850

### Governance

Multi-admin authority for cross-contract operations. Currently operates as a deployer-signed bridge (single admin). Planned for Phase 3: full multisig with 3-of-N admin rotation.

| Field | Value |
|-------|-------|
| **App ID (testnet)** | `762889174` |
| **Lora Explorer** | [view](https://lora.algokit.io/testnet/application/762889174) |
| **Source** | [`smart_contracts/governance/contract.algo.ts`](./projects/irion-contracts/smart_contracts/governance/contract.algo.ts) |

**Key methods:** `admin_force_set_param`, `propose_param`, `rotate_admins`, `get_admins`, `get_param`

### AccountRegistry

Maps institution IDs to on-chain identifiers. Used by Vault and LoanFactory for cross-contract authorization. Manages KYB attestation, suspension, and product gating.

| Field | Value |
|-------|-------|
| **App ID (testnet)** | `762889254` |
| **Lora Explorer** | [view](https://lora.algokit.io/testnet/application/762889254) |
| **Source** | [`smart_contracts/account_registry/contract.algo.ts`](./projects/irion-contracts/smart_contracts/account_registry/contract.algo.ts) |

**Key methods:** `register_institution`, `attest_kyb`, `reject_kyb`, `suspend_institution`, `reinstate_institution`, `get_profile`

---

## Contract Interactions

### OVERCOLLATERALIZED Loan Lifecycle

```
1. API: POST /v1/loans (type=OVERCOLLATERALIZED)
2. Worker: calls Vault.create_oracle_entry()          → locks collateral
3. Worker: calls Governance (deployer bridge)          → authorizes borrow
4. Worker: calls LoanFactory.originate_overcollateralized()  → creates loan record
5. Worker: calls LendingPool.borrow()                  → receives USDC
6. Worker: calls CreditOracle.update_on_borrow()       → updates credit profile
7. Loan status: pending → active
```

### Repayment Lifecycle

```
1. API: POST /v1/loans/:id/repay
2. Worker: creates AssetTransferTxn (USDC → LendingPool)
3. Submits to testnet → receives txHash
4. Updates loan status: active → repaid
5. Calls CreditOracle.update_on_repay()                → updates credit profile
```

---

## Storage Model

All per-user and per-loan state uses **Box storage**, not global state. Global state is reserved for protocol-level configuration (authorized apps, rate parameters).

| Contract | Box Prefix | Key Type | Value |
|----------|-----------|----------|-------|
| LendingPool V2 | `l` | `Account` | `LenderPosition` (LP balance, deposits, yield) |
| LoanFactory | `l` | `uint64` | `LoanRecord` (borrower, principal, status, type, maturity) |
| Vault | (vault_id) | `uint64` | `VaultEntry` (borrower, collateral, timelocks) |
| CreditOracle | `\x63` + pubkey | `Account` | `CreditProfile` (borrowed, repaid, defaults, scores) |

---

## Patches Applied During Phase 2

6 contract assertion bugs were surfaced by integration testing and patched:

| # | Contract | Original | Fix | Impact |
|---|----------|----------|-----|--------|
| 1 | LendingPool | `Txn.applicationId.id` | `Global.callerApplicationId` | Inner txn caller identity was reading the inner app ID instead of LoanFactory |
| 2 | Vault | `Txn.applicationId.id` | `Global.callerApplicationId` | Same pattern — `assert_loan_factory_or_governance` failed during CPI |
| 3 | CreditOracle | No `callerApplicationId` check | Added `callerApplicationId` check | LoanFactory CPI into Oracle was unauthorized |
| 4 | SDK helper | `readGlobalStateUint64` | camelCase + Uint8Array + BigInt | algosdk v3 triple-bug: camelCase keys, Uint8Array key encoding, BigInt return values |
| 5 | CreditOracle | Box declared on inner txn | Box declared on outer txn | AVM requires Box reference on the outermost transaction for inner txn access |
| 6 | LoanFactory | `asHex` encoding | `asBase64` encoding | Loan counter global state read mismatch |

All patches deployed and active on testnet contracts listed above.

---

## Known Limitations

| Limitation | Details | Phase 3 Fix |
|-----------|---------|-------------|
| **CreditOracle address convention** | LoanFactory passes `Txn.sender` in inner txns, but CreditOracle expects the institution's Algorand wallet address. Causes `update_on_repay` CPI to fail for INSTALLMENT loans. | Patch address convention — pass wallet address explicitly in LoanFactory ➝ Oracle calls |
| **Off-chain interest** | Interest computed in `loan-math.ts`, not enforced on-chain | Add interest accrual logic to LoanFactory |
| **Off-chain credit_limit** | `credit_limit=0` for all loan types — drawn amount check only in API route | Set `credit_limit` during loan origination in LoanFactory |
| **Governance bridge** | Deployer mnemonic signs Vault/borrow operations (single point of failure) | Deploy GovernanceMultisig with 3-of-N admin rotation |
| **INSTALLMENT repay** | DB-tracked only — CreditOracle txn fails (address convention mismatch above) | Fix address convention, enable on-chain installment repay |

---

## Build + Deploy

```bash
# Prerequisites: AlgoKit CLI
npm install -g @algorandfoundation/algokit-cli

# Navigate to project root
cd projects/irion-contracts

# Compile all PuyaTS contracts to TEAL
algokit project run build

# Deploy to testnet (requires deployer mnemonic in env)
npx tsx scripts/deploy-all.ts --network testnet
# → Updates deployments/testnet.json with app IDs

# Deploy to mainnet (Phase 3)
npx tsx scripts/deploy-all.ts --network mainnet
```

---

## Testing

```bash
cd projects/irion-contracts

# PuyaTS unit tests
npm test

# Integration tests against deployed testnet contracts
npm run test:integration
```

---

## Phase 3 Contract Roadmap

See [DEFERRED.md](../irion-api/DEFERRED.md) for full backlog with priority rankings.

| Priority | Item | Description |
|----------|------|-------------|
| P0 | CreditOracle address convention | Fix LoanFactory ➝ Oracle CPI for INSTALLMENT loans |
| P0 | On-chain interest | Move interest accrual from loan-math.ts to LoanFactory contract |
| P0 | On-chain credit_limit | Remove `credit_limit=0` — set during origination |
| P0 | Governance multisig | Replace deployer bridge with 3-of-N multisig contract |
| P3 | Liquidator bot | Automated liquidation of overdue loans via a watcher contract |

---

## License

MIT — see [LICENSE](./LICENSE).
