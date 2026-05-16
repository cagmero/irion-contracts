import { AlgorandClient, microAlgo, algo } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import fs from 'fs'
import path from 'path'

import { LendingPoolFactory } from './artifacts/lending_pool/LendingPoolClient'
import { CreditScoreFactory } from './artifacts/credit_score/CreditScoreClient'
import { BnplCreditFactory } from './artifacts/bnpl_credit/BNPLCreditClient'
import { MerchantEscrowFactory } from './artifacts/merchant_escrow/MerchantEscrowClient'

export async function deploy() {
  console.log('=== BNPL Protocol Deployment ===\n')

  const algorand = AlgorandClient.fromEnvironment()
  
  let dispenser: any
  try {
    // Try to get deployer from env first
    dispenser = await algorand.account.fromEnvironment('DEPLOYER')
    console.log('Using DEPLOYER from environment')
  } catch (e) {
    // Fallback to localnet dispenser
    dispenser = await algorand.account.localNetDispenser()
    console.log('Using LocalNet Dispenser')
  }
  
  console.log('Deployer:', dispenser.addr.toString())

  // ─────────────────────────────────────────────
  // STEP 1: Create mock USDC ASA
  // ─────────────────────────────────────────────
  console.log('[1/9] Creating mock USDC ASA...')
  const usdcTxResult = await algorand.send.assetCreate({
    sender: dispenser.addr,
    total: 10_000_000_000_000_000n, // 10 billion USDC (6 decimals)
    decimals: 6,
    defaultFrozen: false,
    unitName: 'USDC',
    assetName: 'USD Coin (Mock)',
    manager: dispenser.addr.toString(),
    reserve: dispenser.addr.toString(),
  })
  const usdcAssetId = BigInt(usdcTxResult.confirmation.assetIndex!)
  console.log('  Mock USDC Asset ID:', usdcAssetId.toString())

  // ─────────────────────────────────────────────
  // STEP 2: Deploy CreditScore (create + bootstrap)
  // ─────────────────────────────────────────────
  console.log('\n[2/9] Creating CreditScore app...')
  const creditScoreFactory = algorand.client.getTypedAppFactory(CreditScoreFactory, {
    defaultSender: dispenser.addr,
  })

  // Create bare (no method call yet)
  const { appClient: creditScoreClient, result: csCreateResult } =
    await creditScoreFactory.send.create.create()
  const creditScoreAppId = creditScoreClient.appId
  const creditScoreAddress = algosdk.getApplicationAddress(creditScoreAppId)
  console.log('  CreditScore App ID:', creditScoreAppId.toString())
  console.log('  CreditScore Address:', creditScoreAddress.toString())

  // Fund app account (0.5 ALGO is plenty)
  console.log('[3/9] Funding CreditScore app account...')
  await algorand.send.payment({
    sender: dispenser.addr,
    receiver: creditScoreAddress,
    amount: algo(0.5),
  })

  // Call bootstrap
  console.log('[3/9] Calling CreditScore bootstrap...')
  await creditScoreClient.send.bootstrap({
    args: [],
  })
  console.log('  CreditScore bootstrapped!')

  // ─────────────────────────────────────────────
  // STEP 3: Deploy LendingPool (create + fund + bootstrap)
  // ─────────────────────────────────────────────
  console.log('\n[4/9] Creating LendingPool app...')
  const lendingPoolFactory = algorand.client.getTypedAppFactory(LendingPoolFactory, {
    defaultSender: dispenser.addr,
  })

  const { appClient: lendingPoolClient } = await lendingPoolFactory.send.create.create()
  const lendingPoolAppId = lendingPoolClient.appId
  const lendingPoolAddress = algosdk.getApplicationAddress(lendingPoolAppId)
  console.log('  LendingPool App ID:', lendingPoolAppId.toString())
  console.log('  LendingPool Address:', lendingPoolAddress.toString())

  // Fund the app BEFORE bootstrap (needs MBR for asset creation + opt-in)
  // 0.1 base + 0.1 asset creation + 0.1 opt-in + buffer = 1 ALGO
  console.log('[5/9] Funding LendingPool app account...')
  await algorand.send.payment({
    sender: dispenser.addr,
    receiver: lendingPoolAddress,
    amount: algo(1),
  })

  // Opt dispenser into USDC first (needed to receive LP tokens etc.)
  console.log('[5/9] Opting dispenser into USDC...')
  await algorand.send.assetOptIn({
    sender: dispenser.addr,
    assetId: usdcAssetId,
  })

  // Call bootstrap with USDC asset ID + extra fee for inner txns (assetConfig + 2×assetTransfer = 3 inner txns)
  console.log('[5/9] Calling LendingPool bootstrap...')
  await lendingPoolClient.send.bootstrap({
    args: [usdcAssetId],
    extraFee: microAlgo(3000), // 3 inner txns × 1000 microAlgo each
  })
  console.log('  LendingPool bootstrapped!')

  // ─────────────────────────────────────────────
  // STEP 4: Link CreditScore ↔ LendingPool
  // ─────────────────────────────────────────────
  console.log('\n[6/9] Linking CreditScore and LendingPool...')
  await lendingPoolClient.send.setCreditScoreApp({
    args: [creditScoreAppId],
  })
  await creditScoreClient.send.setLendingPoolApp({
    args: [lendingPoolAppId],
  })
  console.log('  Linked!')

  // ─────────────────────────────────────────────
  // STEP 5: Deploy BNPLCredit (create + fund + bootstrap)
  // ─────────────────────────────────────────────
  console.log('\n[7/9] Creating BNPLCredit app...')
  const bnplCreditFactory = algorand.client.getTypedAppFactory(BnplCreditFactory, {
    defaultSender: dispenser.addr,
  })

  const { appClient: bnplCreditClient } = await bnplCreditFactory.send.create.create()
  const bnplCreditAppId = bnplCreditClient.appId
  const bnplCreditAddress = algosdk.getApplicationAddress(bnplCreditAppId)
  console.log('  BNPLCredit App ID:', bnplCreditAppId.toString())

  await algorand.send.payment({
    sender: dispenser.addr,
    receiver: bnplCreditAddress,
    amount: algo(0.5),
  })

  await bnplCreditClient.send.bootstrap({
    args: [creditScoreAppId, lendingPoolAppId, usdcAssetId],
  })
  
  console.log('[7/9] Opting BNPLCredit into USDC...')
  await bnplCreditClient.send.optInToAsset({
    args: [usdcAssetId],
    extraFee: microAlgo(1000),
  })
  console.log('  BNPLCredit bootstrapped and opted-in!')

  // ─────────────────────────────────────────────
  // STEP 6: Deploy MerchantEscrow (create + fund + bootstrap)
  // ─────────────────────────────────────────────
  console.log('\n[8/9] Creating MerchantEscrow app...')
  const merchantEscrowFactory = algorand.client.getTypedAppFactory(MerchantEscrowFactory, {
    defaultSender: dispenser.addr,
  })

  const { appClient: merchantEscrowClient } = await merchantEscrowFactory.send.create.create()
  const merchantEscrowAppId = merchantEscrowClient.appId
  const merchantEscrowAddress = algosdk.getApplicationAddress(merchantEscrowAppId)
  console.log('  MerchantEscrow App ID:', merchantEscrowAppId.toString())

  await algorand.send.payment({
    sender: dispenser.addr,
    receiver: merchantEscrowAddress,
    amount: algo(0.5),
  })

  // Opt MerchantEscrow into USDC (needs MBR for asset opt-in)
  // Fund extra 0.1 ALGO for opt-in MBR
  await algorand.send.payment({
    sender: dispenser.addr,
    receiver: merchantEscrowAddress,
    amount: algo(0.2), // Added extra to be safe
  })

  await merchantEscrowClient.send.bootstrap({
    args: [bnplCreditAppId, usdcAssetId],
    extraFee: microAlgo(1000), // 1 inner txn
  })
  console.log('  MerchantEscrow bootstrapped!')

  // ─────────────────────────────────────────────
  // STEP 7: Write deployments.json
  // ─────────────────────────────────────────────
  const deployments = {
    network: 'localnet',
    deployed_at: new Date().toISOString(),
    usdc_asset_id: Number(usdcAssetId),
    credit_score_app_id: Number(creditScoreAppId),
    lending_pool_app_id: Number(lendingPoolAppId),
    bnpl_credit_app_id: Number(bnplCreditAppId),
    merchant_escrow_app_id: Number(merchantEscrowAppId),
    addresses: {
      credit_score: creditScoreAddress.toString(),
      lending_pool: lendingPoolAddress.toString(),
      bnpl_credit: bnplCreditAddress.toString(),
      merchant_escrow: merchantEscrowAddress.toString(),
    }
  }

  const isTestnet = (process.env.ALGOD_NETWORK || '').toLowerCase() === 'testnet'
  const deploymentsFilename = isTestnet ? 'deployments.testnet.json' : 'deployments.json'
  const deploymentsPath = path.join(__dirname, '..', '..', '..', deploymentsFilename)
  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2))

  console.log('\n=== Deployment Complete ===')
  console.log(JSON.stringify(deployments, null, 2))
  console.log('\ndeployments.json written to:', deploymentsPath)
}

deploy().catch((err) => {
  console.error('Deployment failed:', err)
  process.exit(1)
})