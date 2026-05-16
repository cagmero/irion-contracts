# FORKED_FROM

This repository is the **B2B evolution** of `irion-contracts`.

| Field | Value |
|---|---|
| Original repository | `irion-contracts` (B2C BNPL — preserved as failsafe) |
| Source commit SHA | `17e11b47b6871dda9e1d31ff418d1531474482e2` |
| Forked at | 2026-05-16 |
| B2C live deployment | Algorand Testnet |
| B2C App IDs | CreditScore: 758916974 · LendingPool: 758916996 · BNPLCredit: 758917027 · MerchantEscrow: 758917045 |
| B2C iUSDC Asset ID | 758916950 |

## What Changed vs. the Original

The original 4 contracts (`CreditScore`, `LendingPool`, `BNPLCredit`, `MerchantEscrow`) are **untouched**.

Six new B2B contracts have been added alongside them:
- `account_registry` — institutional KYB registry
- `lending_pool_v2` — multi-asset + tranches + kinked utilization curve
- `credit_oracle` — multi-dimensional credit scoring
- `loan_factory` — 4 loan types (OVERCOLLATERALIZED, REVOLVING, TERM, INSTALLMENT)
- `vault` — generalized collateral + settlement escrow
- `governance` — 3-of-3 multisig parameter controller

## How to Cherry-Pick Critical Fixes

```bash
# If a critical bug fix lands in the B2B contracts that should go back to B2C:
git remote add b2b <b2b-repo-url>
git fetch b2b
git cherry-pick <commit-sha>
```
