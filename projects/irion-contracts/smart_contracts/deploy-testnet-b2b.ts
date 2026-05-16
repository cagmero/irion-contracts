/**
 * Irion B2B — Testnet Deployment Script
 *
 * Deploys all 6 new B2B contracts to Algorand Testnet in dependency order:
 *   1. Governance (no deps)
 *   2. AccountRegistry (deps: Governance address)
 *   3. LendingPool v2 USDC (deps: Governance address)
 *   4. LendingPool v2 ALGO (deps: Governance address)
 *   5. CreditOracle (deps: Governance, LoanFactory placeholder — updated after step 6)
 *   6. Vault (deps: Governance)
 *   7. LoanFactory (deps: Governance, CreditOracle, Vault)
 *
 * Uses iUSDC ASA 758916950 (existing live testnet asset — no new ASA created).
 * Writes deployments.b2b.testnet.json.
 *
 * Run: ts-node --transpile-only -r dotenv/config smart_contracts/deploy-testnet-b2b.ts
 */

import { AlgorandClient, algo, microAlgo, Config } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import fs from 'fs'
import path from 'path'

// Disable automatic resource population — deploy scripts don't need simulate overhead
// and the 3-admin bootstrap bytes were being misinterpreted as account references.
Config.configure({ populateAppCallResources: false })

// NOTE: These typed clients are generated after `npm run build`.
// Run `npm run build` first, then run this deploy script.
import { GovernanceFactory } from './artifacts/governance/GovernanceClient'
import { AccountRegistryFactory } from './artifacts/account_registry/AccountRegistryClient'
import { LendingPoolV2Factory } from './artifacts/lending_pool_v2/LendingPoolV2Client'
import { CreditOracleFactory } from './artifacts/credit_oracle/CreditOracleClient'
import { VaultFactory } from './artifacts/vault/VaultClient'
import { LoanFactoryFactory } from './artifacts/loan_factory/LoanFactoryClient'

// ── iUSDC — existing live Testnet ASA (758916950). No new ASA created. ───────
const IUSDC_ASSET_ID = BigInt(758916950)
// ALGO asset ID convention = 0
const ALGO_ASSET_ID = BigInt(0)

export async function deploy() {
  console.log('═══════════════════════════════════════════════')
  console.log('  Irion B2B — Testnet Deployment')
  console.log('═══════════════════════════════════════════════\n')

  const algorand = AlgorandClient.fromEnvironment()

  const deployer = await algorand.account.fromEnvironment('DEPLOYER')
  console.log('Deployer:', deployer.addr.toString())

  // Verify deployer has iUSDC opt-in and sufficient balance
  console.log('\n[0/8] Pre-flight checks...')
  const deployerInfo = await algorand.client.algod.accountInformation(deployer.addr.toString()).do()
  const deployerAlgoBalance = Number(deployerInfo.amount) / 1e6
  console.log(`  Deployer ALGO balance: ${deployerAlgoBalance.toFixed(3)} ALGO`)
  if (deployerAlgoBalance < 10) {
    console.warn('  ⚠️  Low balance. Fund from: https://bank.testnet.algorand.network')
    console.warn('  ⚠️  Need at least 10 ALGO to cover MBR + fees for 6 contracts')
  }

  // ── 1. Deploy Governance ─────────────────────────────────────────────────
  console.log('\n[1/8] Deploying Governance...')
  const govFactory = algorand.client.getTypedAppFactory(GovernanceFactory, {
    defaultSender: deployer.addr,
  })
  const { appClient: govClient } = await govFactory.send.create.create()
  const govAppId = govClient.appId
  const govAddress = algosdk.getApplicationAddress(govAppId)
  console.log(`  App ID: ${govAppId}  Address: ${govAddress}`)

  await algorand.send.payment({ sender: deployer.addr, receiver: govAddress, amount: algo(1) })

  // Bootstrap: all 3 admins = deployer for MVP
  // Pass raw address bytes (32 bytes each) — NOT publicKey which triggers account reference resolution
  const deployerAddrBytes = algosdk.decodeAddress(deployer.addr.toString()).publicKey

  // Step 1: bootstrap sets only admin addresses (no box refs = no reference limit)
  await govClient.send.bootstrap({
    args: [
      deployerAddrBytes,
      deployerAddrBytes,
      deployerAddrBytes,
    ],
  })
  console.log('  ✓ Governance admins set (all = deployer for MVP)')

  // Step 2: set governance parameters via admin_force_set_param (1 admin, 1 box ref per call)
  const setParam = async (key: string, value: bigint) => {
    const keyBytes = new TextEncoder().encode(key)
    // BoxMap keyPrefix:'p' means box name = 'p' + key bytes
    const boxName = new Uint8Array([0x70, ...keyBytes]) // 0x70 = 'p'
    await govClient.send.adminForceSetParam({
      args: [keyBytes, value],
      boxReferences: [{ appId: govAppId, name: boxName }],
    })
  }

  console.log('  Setting governance parameters...')
  await setParam('rate_kink_bps', BigInt(8000))
  await setParam('rate_base_bps', BigInt(200))
  await setParam('rate_slope1_bps', BigInt(400))
  await setParam('rate_slope2_bps', BigInt(7500))
  await setParam('reserve_factor_bps', BigInt(1000))
  await setParam('score_repayment_w', BigInt(400))
  await setParam('score_volume_w', BigInt(250))
  await setParam('score_tenure_w', BigInt(200))
  await setParam('score_conc_w', BigInt(150))
  await setParam('circuit_breaker_bps', BigInt(9500))
  await setParam('senior_yield_bps', BigInt(300))
  console.log('  ✓ Governance bootstrapped + all 11 parameters set')

  // ── 2. Deploy AccountRegistry ─────────────────────────────────────────────
  console.log('\n[2/8] Deploying AccountRegistry...')
  const arFactory = algorand.client.getTypedAppFactory(AccountRegistryFactory, {
    defaultSender: deployer.addr,
  })
  const { appClient: arClient } = await arFactory.send.create.create()
  const arAppId = arClient.appId
  const arAddress = algosdk.getApplicationAddress(arAppId)
  console.log(`  App ID: ${arAppId}  Address: ${arAddress}`)

  await algorand.send.payment({ sender: deployer.addr, receiver: arAddress, amount: algo(0.5) })
  await arClient.send.bootstrap({
    args: [deployerAddrBytes],
    accounts: [deployer.addr.toString()],
  }) // governance = deployer
  console.log('  ✓ AccountRegistry bootstrapped')

  // ── 3. Deploy LendingPool v2 — iUSDC pool ────────────────────────────────
  console.log('\n[3/8] Deploying LendingPool v2 (iUSDC)...')
  const lpFactory = algorand.client.getTypedAppFactory(LendingPoolV2Factory, {
    defaultSender: deployer.addr,
  })
  const { appClient: lpUsdcClient } = await lpFactory.send.create.create()
  const lpUsdcAppId = lpUsdcClient.appId
  const lpUsdcAddress = algosdk.getApplicationAddress(lpUsdcAppId)
  console.log(`  App ID: ${lpUsdcAppId}  Address: ${lpUsdcAddress}`)

  // Fund generously: MBR base + 2 LP ASAs + pool asset opt-in + buffer
  await algorand.send.payment({ sender: deployer.addr, receiver: lpUsdcAddress, amount: algo(2) })

  await lpUsdcClient.send.bootstrap({
    args: [
      deployerAddrBytes,  // governance
      IUSDC_ASSET_ID,           // pool_asset_id
      BigInt(200),              // rate_base_bps  = 2%
      BigInt(400),              // rate_slope1_bps = 4%
      BigInt(7500),             // rate_slope2_bps = 75%
      BigInt(8000),             // rate_kink_bps   = 80%
      BigInt(1000),             // reserve_factor_bps = 10%
      BigInt(9500),             // circuit_breaker_bps = 95%
      BigInt(300),              // senior_yield_floor_bps = 3%
    ],
    accounts: [deployer.addr.toString()],
  })

  // Create LP token ASAs (separate from bootstrap to avoid MBR issues)
  await lpUsdcClient.send.createAssets({
    args: [new TextEncoder().encode('iUSDC')],
    extraFee: microAlgo(5000), // 5 inner txns (2 assetConfig + opt-in + pool asset opt-in)
    assetReferences: [IUSDC_ASSET_ID],
  })
  console.log('  ✓ LendingPool v2 (iUSDC) bootstrapped + LP tokens created')

  // ── 4. Deploy LendingPool v2 — ALGO pool ──────────────────────────────────
  console.log('\n[4/8] Deploying LendingPool v2 (ALGO)...')
  const { appClient: lpAlgoClient } = await lpFactory.send.create.create()
  const lpAlgoAppId = lpAlgoClient.appId
  const lpAlgoAddress = algosdk.getApplicationAddress(lpAlgoAppId)
  console.log(`  App ID: ${lpAlgoAppId}  Address: ${lpAlgoAddress}`)

  await algorand.send.payment({ sender: deployer.addr, receiver: lpAlgoAddress, amount: algo(2) })

  await lpAlgoClient.send.bootstrap({
    args: [
      deployerAddrBytes,
      ALGO_ASSET_ID,
      BigInt(150),   // rate_base_bps = 1.5%
      BigInt(350),   // rate_slope1_bps
      BigInt(6000),  // rate_slope2_bps
      BigInt(8000),  // rate_kink_bps
      BigInt(1000),  // reserve_factor_bps
      BigInt(9500),  // circuit_breaker_bps
      BigInt(200),   // senior_yield_floor_bps
    ],
    accounts: [deployer.addr.toString()],
  })

  await lpAlgoClient.send.createAssets({
    args: [new TextEncoder().encode('ALGO')],
    extraFee: microAlgo(4000), // ALGO pool: no pool asset opt-in inner txn
    assetReferences: [IUSDC_ASSET_ID], // still reference for consistency
  })
  console.log('  ✓ LendingPool v2 (ALGO) bootstrapped + LP tokens created')

  // ── 5. Deploy Vault ───────────────────────────────────────────────────────
  console.log('\n[5/8] Deploying Vault...')
  const vaultFactory = algorand.client.getTypedAppFactory(VaultFactory, {
    defaultSender: deployer.addr,
  })
  const { appClient: vaultClient } = await vaultFactory.send.create.create()
  const vaultAppId = vaultClient.appId
  const vaultAddress = algosdk.getApplicationAddress(vaultAppId)
  console.log(`  App ID: ${vaultAppId}  Address: ${vaultAddress}`)

  await algorand.send.payment({ sender: deployer.addr, receiver: vaultAddress, amount: algo(1) })
  // LoanFactory not known yet — will call update_loan_factory after step 7
  await vaultClient.send.bootstrap({
    args: [deployerAddrBytes, BigInt(0)],
    accounts: [deployer.addr.toString()],
  })

  // Opt Vault into iUSDC
  await vaultClient.send.optInToAsset({
    args: [IUSDC_ASSET_ID],
    extraFee: microAlgo(1000),
    assetReferences: [IUSDC_ASSET_ID],
  })
  console.log('  ✓ Vault bootstrapped + opted into iUSDC')

  // ── 6. Deploy CreditOracle ────────────────────────────────────────────────
  console.log('\n[6/8] Deploying CreditOracle...')
  const oracleFactory = algorand.client.getTypedAppFactory(CreditOracleFactory, {
    defaultSender: deployer.addr,
  })
  const { appClient: oracleClient } = await oracleFactory.send.create.create()
  const oracleAppId = oracleClient.appId
  const oracleAddress = algosdk.getApplicationAddress(oracleAppId)
  console.log(`  App ID: ${oracleAppId}  Address: ${oracleAddress}`)

  await algorand.send.payment({ sender: deployer.addr, receiver: oracleAddress, amount: algo(0.5) })
  // LoanFactory not known yet — placeholder BigInt(0), updated after step 7
  await oracleClient.send.bootstrap({
    args: [deployerAddrBytes, BigInt(0), lpUsdcAppId],
    accounts: [deployer.addr.toString()],
  })
  console.log('  ✓ CreditOracle bootstrapped')

  // ── 7. Deploy LoanFactory ─────────────────────────────────────────────────
  console.log('\n[7/8] Deploying LoanFactory...')
  const lfFactory = algorand.client.getTypedAppFactory(LoanFactoryFactory, {
    defaultSender: deployer.addr,
  })
  const { appClient: lfClient } = await lfFactory.send.create.create()
  const lfAppId = lfClient.appId
  const lfAddress = algosdk.getApplicationAddress(lfAppId)
  console.log(`  App ID: ${lfAppId}  Address: ${lfAddress}`)

  await algorand.send.payment({ sender: deployer.addr, receiver: lfAddress, amount: algo(0.5) })
  await lfClient.send.bootstrap({
    args: [deployerAddrBytes, oracleAppId, vaultAppId, IUSDC_ASSET_ID],
    accounts: [deployer.addr.toString()],
  })

  // Register pools — pool_registry BoxMap keyPrefix='r', box = 0x72 + asset_id (8 bytes, big-endian)
  const poolBoxRef = (assetId: bigint): Uint8Array => {
    const buf = Buffer.alloc(9)
    buf[0] = 0x72 // 'r'
    buf.writeBigUInt64BE(assetId, 1)
    return new Uint8Array(buf)
  }

  await lfClient.send.registerPool({
    args: [IUSDC_ASSET_ID, lpUsdcAppId],
    boxReferences: [{ appId: lfAppId, name: poolBoxRef(IUSDC_ASSET_ID) }],
    assetReferences: [IUSDC_ASSET_ID],
  })
  await lfClient.send.registerPool({
    args: [ALGO_ASSET_ID, lpAlgoAppId],
    boxReferences: [{ appId: lfAppId, name: poolBoxRef(ALGO_ASSET_ID) }],
  })
  console.log('  ✓ LoanFactory bootstrapped + pools registered')

  // ── 8. Wire cross-contract references ────────────────────────────────────
  console.log('\n[8/8] Wiring cross-contract references...')

  // Update CreditOracle with real LoanFactory ID
  await oracleClient.send.updateAuthorizedApp({ args: [lfAppId, lpUsdcAppId] })

  // Update Vault with real LoanFactory ID
  await vaultClient.send.updateLoanFactory({ args: [lfAppId] })

  // Wire LendingPool v2 instances to LoanFactory + Oracle
  await lpUsdcClient.send.setAuthorizedApps({ args: [lfAppId, oracleAppId] })
  await lpAlgoClient.send.setAuthorizedApps({ args: [lfAppId, oracleAppId] })

  console.log('  ✓ All cross-contract references wired')

  // ── Write deployments file ────────────────────────────────────────────────
  const deployments = {
    network: 'testnet',
    deployed_at: new Date().toISOString(),
    deployer_address: deployer.addr.toString(),
    module: 'b2b',
    iusdc_asset_id: Number(IUSDC_ASSET_ID),
    governance_app_id: Number(govAppId),
    account_registry_app_id: Number(arAppId),
    lending_pool_v2_usdc_app_id: Number(lpUsdcAppId),
    lending_pool_v2_algo_app_id: Number(lpAlgoAppId),
    credit_oracle_app_id: Number(oracleAppId),
    vault_app_id: Number(vaultAppId),
    loan_factory_app_id: Number(lfAppId),
    addresses: {
      governance: govAddress,
      account_registry: arAddress,
      lending_pool_v2_usdc: lpUsdcAddress,
      lending_pool_v2_algo: lpAlgoAddress,
      credit_oracle: oracleAddress,
      vault: vaultAddress,
      loan_factory: lfAddress,
    },
    explorer: {
      governance: `https://testnet.explorer.perawallet.app/application/${govAppId}`,
      account_registry: `https://testnet.explorer.perawallet.app/application/${arAppId}`,
      lending_pool_v2_usdc: `https://testnet.explorer.perawallet.app/application/${lpUsdcAppId}`,
      lending_pool_v2_algo: `https://testnet.explorer.perawallet.app/application/${lpAlgoAppId}`,
      credit_oracle: `https://testnet.explorer.perawallet.app/application/${oracleAppId}`,
      vault: `https://testnet.explorer.perawallet.app/application/${vaultAppId}`,
      loan_factory: `https://testnet.explorer.perawallet.app/application/${lfAppId}`,
      iusdc: `https://testnet.explorer.perawallet.app/asset/${IUSDC_ASSET_ID}`,
    },
  }

  const outPath = path.join(__dirname, '..', '..', '..', 'deployments.b2b.testnet.json')
  fs.writeFileSync(outPath, JSON.stringify(deployments, null, 2))

  console.log('\n═══════════════════════════════════════════════')
  console.log('  Deployment Complete ✓')
  console.log('═══════════════════════════════════════════════')
  console.log(JSON.stringify(deployments, null, 2))
  console.log('\n  deployments.b2b.testnet.json written to:', outPath)
  console.log('\n  ⚡ Next step: copy App IDs into .env.local files in each repo')
}

deploy().catch((err) => {
  console.error('Deployment failed:', err)
  process.exit(1)
})
