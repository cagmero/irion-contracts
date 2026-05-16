# BNPL Protocol Deployment Audit Report

## Executive Summary

This report documents the deployment of 4 Algorand smart contracts for a Buy Now Pay Later (BNPL) protocol using PuyaTS (Algorand TypeScript). All contracts compile successfully, but deployment fails due to AVM transaction and asset creation constraints.

---

## Contracts Overview

| Contract | Purpose | Key Features |
|----------|---------|--------------|
| **CreditScore** | Credit scoring system | BoxMap storage for credit profiles, score calculation with bonuses/penalties |
| **LendingPool** | Lending/borrowing pool | Creates LP token, deposit/withdraw/borrow/repay, interest calculation |
| **BNPLCredit** | BNPL loan management | Installment tracking, late fees, loan lifecycle |
| **MerchantEscrow** | Payment escrow | Settlement delay, release/refund logic |

---

## Root Causes of Deployment Failure

### 1. Inner Transaction Fee Pooling Issue

**Problem:** Inner transactions in AVM need their fees covered by the outer transaction via fee pooling, NOT by setting `fee: Uint64(0)` in the contract.

**Observation:** The `fee: Uint64(0)` pattern in inner transactions doesn't work as expected—the caller must provide extra fees via `extraFee: microAlgo(N)`.

**Status:** ✅ Fixed in deploy-config.ts by adding `extraFee` to each deployment.

### 2. Asset Creation MBR Requirement

**Problem:** Apps creating assets need minimum balance before creating assets. For 1 asset: 200,000 microAlgos (0.2 ALGO). The app account must be funded BEFORE deployment because asset creation happens during bootstrap.

**Current Approach:** Pre-funding app addresses (1024-1500 range).

**Status:** ❌ Still failing—AlgoKit simulation uses unpredictable/future app IDs.

### 3. AlgoKit Simulation App ID Quirk

**Problem:** When using AlgorandClient, simulation assigns unpredictable/future app IDs (1025 → 1072 → 1250 → 1729), making pre-funding specific app addresses unreliable.

**Root Cause:** Algokit simulates multiple potential app IDs during transaction simulation, not the actual app ID that will be created.

---

## Contract Analysis

### 1. CreditScore (credit_score/contract.algo.ts)

**Bootstrap:**
```typescript
@abimethod({ onCreate: 'require' })
public bootstrap(): void {
  this.min_score.value = MIN_SCORE
  this.max_score.value = MAX_SCORE
  this.lending_pool_app_id.value = Uint64(0)
}
```

**Storage:**
- GlobalState: `min_score`, `max_score`, `lending_pool_app_id`
- BoxMap: `credit_profiles` (Account → CreditProfile)

**Key Methods:**
- `create_profile()` - Initialize user credit profile
- `update_score_on_deposit(user, amount)` - Update score on deposit
- `update_score_on_borrow(user, amount)` - Decrease score on new loan
- `update_score_on_repay(user, amount, on_time)` - Update on repayment
- `update_score_on_default(user)` - Heavy penalty on default
- `get_score(user)` - Read-only score getter
- `get_borrow_limit(user)` - Calculate borrow limit based on score

### 2. LendingPool (lending_pool/contract.algo.ts)

**Bootstrap with Asset Creation:**
```typescript
@abimethod({ onCreate: 'require' })
public bootstrap(pool_asset_id: uint64): void {
  this.pool_asset_id.value = pool_asset_id

  // Create LP token (1 trillion supply, 6 decimals)
  const create_lp_token = itxn.assetConfig({
    total: Uint64(1_000_000_000_000),
    decimals: Uint64(6),
    unitName: 'LPC',
    assetName: 'Irion LP',
    manager: Global.currentApplicationAddress,
    reserve: Global.currentApplicationAddress,
  }).submit()

  this.lp_token_id.value = create_lp_token.createdAsset.id
  
  // Opt-in to LP token (zero-value transfer)
  itxn.assetTransfer({
    xferAsset: this.lp_token_id.value,
    assetReceiver: Global.currentApplicationAddress,
    assetAmount: Uint64(0),
  }).submit()

  this.total_deposits.value = Uint64(0)
  this.total_borrowed.value = Uint64(0)
  this.reserve_factor.value = Uint64(1000)
  this.interest_rate_base.value = Uint64(500)
  this.last_update_round.value = Global.round
}
```

**Storage:**
- GlobalState: `total_deposits`, `total_borrowed`, `reserve_factor`, `interest_rate_base`, `pool_asset_id`, `lp_token_id`, `last_update_round`, `credit_score_app_id`
- BoxMap: `lender_boxes` (Account → LenderPosition)

**Key Methods:**
- `deposit(payment: gtxn.AssetTransferTxn)` - Deposit pool asset, receive LP tokens
- `withdraw(lp_amount: uint64)` - Burn LP tokens, receive pool asset + yield
- `borrow(amount: uint64, borrower: Account)` - Borrow from pool
- `repay(payment: gtxn.AssetTransferTxn, borrower: bytes)` - Repay loan
- `get_pool_stats()` - Read-only pool statistics
- `get_lender_position(lender)` - Read lender's position

### 3. BNPLCredit (bnpl_credit/contract.algo.ts)

**Bootstrap:**
```typescript
@abimethod({ onCreate: 'require' })
public bootstrap(
  credit_score_app_id: uint64,
  lending_pool_app_id: uint64
): void {
  this.credit_score_app_id.value = credit_score_app_id
  this.lending_pool_app_id.value = lending_pool_app_id
  this.loan_counter.value = Uint64(0)
  this.late_fee_bps.value = LATE_FEE_BPS
  this.installment_interval.value = INSTALLMENT_INTERVAL_ROUNDS
}
```

**Storage:**
- GlobalState: `credit_score_app_id`, `lending_pool_app_id`, `loan_counter`, `late_fee_bps`, `installment_interval`
- BoxMap: `loan_boxes` (uint64 → LoanData), `user_loans` (Account → uint64[])

**Key Methods:**
- `initiate_loan(merchant, amount, num_installments)` - Create new BNPL loan
- `make_payment(loan_id, payment)` - Make installment payment
- `dispute_loan(loan_id)` - Borrower disputes loan
- `liquidate_loan(loan_id)` - Liquidate overdue loan
- `get_loan(loan_id)` - Read-only loan details
- `get_user_loans(user)` - Get user's loan IDs

**Inner Transactions:**
- Calls LendingPool `borrow()` method
- Calls LendingPool `repay()` method
- Calls CreditScore `update_score_on_default()` method

### 4. MerchantEscrow (merchant_escrow/contract.algo.ts)

**Bootstrap:**
```typescript
@abimethod({ onCreate: 'require' })
public bootstrap(bnpl_app_id: uint64, usdc_asset_id: uint64): void {
  this.bnpl_app_id.value = bnpl_app_id
  this.settlement_delay_rounds.value = SETTLEMENT_DELAY_ROUNDS
  this.usdc_asset_id.value = usdc_asset_id
}
```

**Storage:**
- GlobalState: `bnpl_app_id`, `settlement_delay_rounds`, `usdc_asset_id`
- BoxMap: `escrow_boxes` (uint64 → EscrowData)

**Key Methods:**
- `create_escrow(loan_id, merchant, payment)` - Create escrow for loan
- `release_to_merchant(loan_id)` - Release funds to merchant after delay
- `refund_to_borrower(loan_id, borrower)` - Refund to borrower
- `get_escrow(loan_id)` - Read-only escrow details

---

## Deployment Code

### Full deploy-config.ts

```typescript
import { AlgorandClient, microAlgo, algo } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'

import { LendingPoolFactory } from './artifacts/lending_pool/LendingPoolClient'
import { CreditScoreFactory } from './artifacts/credit_score/CreditScoreClient'
import { BNPLCreditFactory } from './artifacts/bnpl_credit/BNPLCreditClient'
import { MerchantEscrowFactory } from './artifacts/merchant_escrow/MerchantEscrowClient'

function getAppAddress(appId: number): string {
  return algosdk.getApplicationAddress(appId).toString()
}

console.log('Script loaded, starting deployment...')

export async function deploy() {
  console.log('=== BNPL Protocol Deployment ===')

  const algorand = AlgorandClient.fromEnvironment()
  const dispenser = await algorand.account.localNetDispenser()
  const creator = dispenser.addr.toString()
  console.log('Deployer:', creator)

  // Pre-fund all potential app addresses (1024-1500 range to be safe)
  console.log('\n[Pre-funding] Funding potential app addresses...')
  const startAppId = 1024
  const endAppId = 1500
  for (let appId = startAppId; appId <= endAppId; appId++) {
    const addr = getAppAddress(appId)
    console.log(`  Funding app ${appId}: ${addr}`)
    await algorand.send.payment({
      sender: dispenser.addr,
      receiver: addr,
      amount: algo(3),
    })
  }
  console.log('  Done funding app addresses')

  // Deploy CreditScore with bootstrap
  console.log('\n[1/5] Deploying CreditScore with bootstrap...')
  const creditScoreFactory = algorand.client.getTypedAppFactory(CreditScoreFactory, {
    defaultSender: dispenser.addr,
  })

  const { appClient: creditScoreClient } = await creditScoreFactory.deploy({
    createParams: {
      method: 'bootstrap()void',
    },
    onUpdate: 'append',
    onSchemaBreak: 'append',
    extraFee: microAlgo(1000),
  })
  console.log('CreditScore App ID:', creditScoreClient.appId)

  // Deploy LendingPool with bootstrap
  console.log('\n[2/5] Deploying LendingPool with bootstrap...')
  const lendingPoolFactory = algorand.client.getTypedAppFactory(LendingPoolFactory, {
    defaultSender: dispenser.addr,
  })

  const { appClient: lendingPoolClient } = await lendingPoolFactory.deploy({
    createParams: {
      method: 'bootstrap(uint64)void',
      args: [1n],
    },
    onUpdate: 'append',
    onSchemaBreak: 'append',
    extraFee: microAlgo(3000),
  })
  console.log('LendingPool App ID:', lendingPoolClient.appId)

  // Link contracts
  console.log('\n[3/5] Linking CreditScore and LendingPool...')
  
  const creditScoreClientForCall = creditScoreFactory.getAppClientFromGlobalState({})
  const lendingPoolClientForCall = lendingPoolFactory.getAppClientFromGlobalState({})

  await lendingPoolClientForCall.send.set_credit_score_app({
    args: { app_id: creditScoreClient.appId },
  })
  
  await creditScoreClientForCall.send.set_lending_pool_app({
    args: { app_id: lendingPoolClient.appId },
  })
  console.log('Contracts linked!')

  // Deploy BNPLCredit with bootstrap
  console.log('\n[4/5] Deploying BNPLCredit with bootstrap...')
  const bnplCreditFactory = algorand.client.getTypedAppFactory(BNPLCreditFactory, {
    defaultSender: dispenser.addr,
  })

  const { appClient: bnplCreditClient } = await bnplCreditFactory.deploy({
    createParams: {
      method: 'bootstrap(uint64,uint64)void',
      args: [creditScoreClient.appId, lendingPoolClient.appId],
    },
    onUpdate: 'append',
    onSchemaBreak: 'append',
    extraFee: microAlgo(1000),
  })
  console.log('BNPLCredit App ID:', bnplCreditClient.appId)

  // Deploy MerchantEscrow with bootstrap
  console.log('\n[5/5] Deploying MerchantEscrow with bootstrap...')
  const merchantEscrowFactory = algorand.client.getTypedAppFactory(MerchantEscrowFactory, {
    defaultSender: dispenser.addr,
  })

  const { appClient: merchantEscrowClient } = await merchantEscrowFactory.deploy({
    createParams: {
      method: 'bootstrap(uint64,uint64)void',
      args: [bnplCreditClient.appId, 1n],
    },
    onUpdate: 'append',
    onSchemaBreak: 'append',
    extraFee: microAlgo(1000),
  })
  console.log('MerchantEscrow App ID:', merchantEscrowClient.appId)

  console.log('\n=== Deployment Complete ===')
  console.log('CreditScore:', creditScoreClient.appId)
  console.log('LendingPool:', lendingPoolClient.appId)
  console.log('BNPLCredit:', bnplCreditClient.appId)
  console.log('MerchantEscrow:', merchantEscrowClient.appId)
}
```

---

## Issues Summary

| Issue | Description | Status |
|-------|-------------|--------|
| Fee too small | Inner transactions need extra fees from outer txn | ✅ Fixed via extraFee |
| Asset creation MBR | App needs 0.2 ALGO before creating asset | ❌ Failing |
| Pre-funding unreliable | AlgoKit simulation uses unpredictable app IDs | ❌ Failing |
| Asset opt-in in bootstrap | App must opt-in to created LP token | ✅ Added zero-value transfer |

---

## Next Steps to Fix

1. **Use AlgoKit's built-in `fundAppAccount` method** - Pass funding as part of the ABI method call instead of pre-funding addresses
2. **Simplify contracts** - Remove asset creation from bootstrap to avoid MBR issue during app creation
3. **Deploy without bootstrap** - Deploy contracts first, then call bootstrap as separate transactions
4. **Debug AlgoKit simulation** - Understand why simulation assigns high app IDs and find workaround

---

## Files Reference

- Deploy script: `irion-contracts/projects/irion-contracts/smart_contracts/deploy-config.ts`
- CreditScore: `irion-contracts/projects/irion-contracts/smart_contracts/credit_score/contract.algo.ts`
- LendingPool: `irion-contracts/projects/irion-contracts/smart_contracts/lending_pool/contract.algo.ts`
- BNPLCredit: `irion-contracts/projects/irion-contracts/smart_contracts/bnpl_credit/contract.algo.ts`
- MerchantEscrow: `irion-contracts/projects/irion-contracts/smart_contracts/merchant_escrow/contract.algo.ts`