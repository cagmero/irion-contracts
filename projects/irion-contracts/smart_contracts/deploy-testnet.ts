import algosdk from 'algosdk'
import { AlgorandClient, algo, microAlgo } from '@algorandfoundation/algokit-utils'
import fs from 'fs'
import path from 'path'

import { CreditScoreFactory } from './artifacts/credit_score/CreditScoreClient'
import { LendingPoolFactory } from './artifacts/lending_pool/LendingPoolClient'
import { BnplCreditFactory } from './artifacts/bnpl_credit/BNPLCreditClient'
import { MerchantEscrowFactory } from './artifacts/merchant_escrow/MerchantEscrowClient'

const DEPLOYER_MNEMONIC = 'announce feed swing base certain rib rose phrase crouch rotate voyage enroll same sort flush emotion pulp airport notice inject pelican zero blossom about honey'

const ALGOD_SERVER = 'https://testnet-api.algonode.cloud'
const ALGOD_PORT = 443
const ALGOD_TOKEN = ''

async function deploy() {
  console.log('=== Irion BNPL — Algorand Testnet Deployment ===\n')

  // Connect to testnet
  const algod = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT)
  
  // Verify connection
  const status = await algod.status().do()
  console.log('Connected to testnet. Last round:', status['last-round'])

  // Restore deployer account from mnemonic
  const deployer = algosdk.mnemonicToSecretKey(DEPLOYER_MNEMONIC)
  console.log('Deployer address:', deployer.addr.toString())

  // Check deployer balance
  const accountInfo = await algod.accountInformation(deployer.addr.toString()).do()
  const balanceAlgo = Number(accountInfo.amount) / 1_000_000
  console.log('Deployer balance:', balanceAlgo.toFixed(4), 'ALGO')

  if (balanceAlgo < 10) {
    console.error('ERROR: Deployer needs at least 10 ALGO on testnet.')
    console.error('Fund this address at https://bank.testnet.algorand.network/')
    console.error('Address:', deployer.addr.toString())
    process.exit(1)
  }

  const algorand = AlgorandClient.fromClients({ algod })
  algorand.setDefaultSigner(algosdk.makeBasicAccountTransactionSigner(deployer))
  algorand.setDefaultValidityWindow(1000)

  // ─────────────────────────────────────────────
  // STEP 1: Create iUSDC ASA
  // ─────────────────────────────────────────────
  console.log('\n[1/9] Creating iUSDC (Irion Test USDC) ASA...')

  const iusdcResult = await algorand.send.assetCreate({
    sender: deployer.addr.toString(),
    total: 100_000_000_000_000n,  // 100 billion iUSDC (6 decimals)
    decimals: 6,
    defaultFrozen: false,
    unitName: 'iUSDC',
    assetName: 'Irion Test USDC',
    url: 'ipfs://QmPetoWsGd9f7RfXm5685vcfJwascaqfXX1WE9ojTs1Bgs',
    manager: deployer.addr.toString(),
    reserve: deployer.addr.toString(),
    freeze: deployer.addr.toString(),
    clawback: deployer.addr.toString(),
  })

  const iusdcAssetId = BigInt(iusdcResult.confirmation.assetIndex!)
  console.log('  iUSDC Asset ID:', iusdcAssetId.toString())
  console.log('  iUSDC Creator (faucet):', deployer.addr.toString())

  // ─────────────────────────────────────────────
  // STEP 2: Deploy CreditScore
  // ─────────────────────────────────────────────
  console.log('\n[2/9] Creating CreditScore app...')

  const creditScoreFactory = algorand.client.getTypedAppFactory(CreditScoreFactory, {
    defaultSender: deployer.addr.toString(),
  })

  const { appClient: creditScoreClient } = await creditScoreFactory.send.create.create()
  const creditScoreAppId = creditScoreClient.appId
  const creditScoreAddress = algosdk.getApplicationAddress(creditScoreAppId)
  console.log('  CreditScore App ID:', creditScoreAppId.toString())
  console.log('  CreditScore Address:', creditScoreAddress.toString())

  console.log('[3/9] Funding & bootstrapping CreditScore...')
  await algorand.send.payment({
    sender: deployer.addr.toString(),
    receiver: creditScoreAddress.toString(),
    amount: algo(0.5),
  })

  await creditScoreClient.send.bootstrap({ args: [] })
  console.log('  CreditScore bootstrapped!')

  // ─────────────────────────────────────────────
  // STEP 3: Deploy LendingPool
  // ─────────────────────────────────────────────
  console.log('\n[4/9] Creating LendingPool app...')

  const lendingPoolFactory = algorand.client.getTypedAppFactory(LendingPoolFactory, {
    defaultSender: deployer.addr.toString(),
  })

  const { appClient: lendingPoolClient } = await lendingPoolFactory.send.create.create()
  const lendingPoolAppId = lendingPoolClient.appId
  const lendingPoolAddress = algosdk.getApplicationAddress(lendingPoolAppId)
  console.log('  LendingPool App ID:', lendingPoolAppId.toString())
  console.log('  LendingPool Address:', lendingPoolAddress.toString())

  // Fund with 2 ALGO — needs MBR for LP token creation + iUSDC opt-in
  console.log('[5/9] Funding & bootstrapping LendingPool...')
  await algorand.send.payment({
    sender: deployer.addr.toString(),
    receiver: lendingPoolAddress.toString(),
    amount: algo(2),
  })

  await lendingPoolClient.send.bootstrap({
    args: [iusdcAssetId],
    extraFee: microAlgo(3000),
  })
  console.log('  LendingPool bootstrapped!')

  // ─────────────────────────────────────────────
  // STEP 4: Link CreditScore <-> LendingPool
  // ─────────────────────────────────────────────
  console.log('\n[6/9] Linking contracts...')
  await lendingPoolClient.send.setCreditScoreApp({ args: [creditScoreAppId] })
  await creditScoreClient.send.setLendingPoolApp({ args: [lendingPoolAppId] })
  console.log('  Linked!')

  // ─────────────────────────────────────────────
  // STEP 5: Deploy BNPLCredit
  // ─────────────────────────────────────────────
  console.log('\n[7/9] Creating BNPLCredit app...')

  const bnplCreditFactory = algorand.client.getTypedAppFactory(BnplCreditFactory, {
    defaultSender: deployer.addr.toString(),
  })

  const { appClient: bnplCreditClient } = await bnplCreditFactory.send.create.create()
  const bnplCreditAppId = bnplCreditClient.appId
  const bnplCreditAddress = algosdk.getApplicationAddress(bnplCreditAppId)
  console.log('  BNPLCredit App ID:', bnplCreditAppId.toString())

  await algorand.send.payment({
    sender: deployer.addr.toString(),
    receiver: bnplCreditAddress.toString(),
    amount: algo(0.5),
  })

  await bnplCreditClient.send.bootstrap({
    args: [creditScoreAppId, lendingPoolAppId, iusdcAssetId],
  })
  console.log('  BNPLCredit bootstrapped!')

  // ─────────────────────────────────────────────
  // STEP 6: Deploy MerchantEscrow
  // ─────────────────────────────────────────────
  console.log('\n[8/9] Creating MerchantEscrow app...')

  const merchantEscrowFactory = algorand.client.getTypedAppFactory(MerchantEscrowFactory, {
    defaultSender: deployer.addr.toString(),
  })

  const { appClient: merchantEscrowClient } = await merchantEscrowFactory.send.create.create()
  const merchantEscrowAppId = merchantEscrowClient.appId
  const merchantEscrowAddress = algosdk.getApplicationAddress(merchantEscrowAppId)
  console.log('  MerchantEscrow App ID:', merchantEscrowAppId.toString())

  await algorand.send.payment({
    sender: deployer.addr.toString(),
    receiver: merchantEscrowAddress.toString(),
    amount: algo(0.5),
  })

  // MerchantEscrow needs to opt-in to iUSDC — fund extra 0.2 ALGO for MBR
  await algorand.send.payment({
    sender: deployer.addr.toString(),
    receiver: merchantEscrowAddress.toString(),
    amount: algo(0.2),
  })

  await merchantEscrowClient.send.bootstrap({
    args: [bnplCreditAppId, iusdcAssetId],
    extraFee: microAlgo(1000),
  })
  console.log('  MerchantEscrow bootstrapped!')

  // ─────────────────────────────────────────────
  // STEP 7: Write deployments.testnet.json
  // ─────────────────────────────────────────────
  const deployments = {
    network: 'testnet',
    deployed_at: new Date().toISOString(),
    deployer_address: deployer.addr.toString(),
    iusdc_asset_id: Number(iusdcAssetId),
    credit_score_app_id: Number(creditScoreAppId),
    lending_pool_app_id: Number(lendingPoolAppId),
    bnpl_credit_app_id: Number(bnplCreditAppId),
    merchant_escrow_app_id: Number(merchantEscrowAppId),
    addresses: {
      credit_score: creditScoreAddress.toString(),
      lending_pool: lendingPoolAddress.toString(),
      bnpl_credit: bnplCreditAddress.toString(),
      merchant_escrow: merchantEscrowAddress.toString(),
    },
    explorer: {
      credit_score: `https://testnet.explorer.perawallet.app/application/${creditScoreAppId}`,
      lending_pool: `https://testnet.explorer.perawallet.app/application/${lendingPoolAppId}`,
      bnpl_credit: `https://testnet.explorer.perawallet.app/application/${bnplCreditAppId}`,
      merchant_escrow: `https://testnet.explorer.perawallet.app/application/${merchantEscrowAppId}`,
      iusdc: `https://testnet.explorer.perawallet.app/asset/${iusdcAssetId}`,
    }
  }

  // Write to irion-contracts root
  const deploymentsPath = path.join(
    __dirname, '..', '..', '..', 'deployments.testnet.json'
  )
  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2))

  // Also write to irion-contracts/projects/irion-contracts/ for parity
  const deploymentsAltPath = path.join(__dirname, '..', 'deployments.testnet.json')
  fs.writeFileSync(deploymentsAltPath, JSON.stringify(deployments, null, 2))

  console.log('\n=== Testnet Deployment Complete ===')
  console.log(JSON.stringify(deployments, null, 2))
  console.log('\nPera Explorer links:')
  Object.entries(deployments.explorer).forEach(([k, v]) => console.log(`  ${k}: ${v}`))
}

deploy().catch((err) => {
  console.error('\nDeployment failed:', err.message ?? err)
  process.exit(1)
})
