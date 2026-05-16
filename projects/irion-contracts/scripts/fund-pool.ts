import * as algokit from '@algorandfoundation/algokit-utils'
import { LendingPoolClient } from '../smart_contracts/artifacts/lending_pool/LendingPoolClient'
import algosdk from 'algosdk'

async function fundPool() {
  const algorand = algokit.AlgorandClient.fromEnvironment()
  const dispenser = await algorand.account.localNetDispenser()
  
  // NEW IDs from deployments.json
  const usdcAssetId = 1028
  const poolAppId = 1036
  const poolAddress = "OPRKZ57H6B4OFHNUMFBH5ML77PH2XEVXTGI6I6VCIUE5FV3PRDHN4L7UH4"
  const lpTokenId = 1047

  console.log(`Dispenser: ${dispenser.addr}`)
  
  const poolClient = new LendingPoolClient({
    appId: BigInt(poolAppId),
    algorand: algorand,
    defaultSender: dispenser.addr,
  })

  console.log(`LP Token ID: ${lpTokenId}`)

  // Opt-in to LP token
  try {
    await algorand.send.assetOptIn({
        sender: dispenser.addr,
        assetId: BigInt(lpTokenId),
    })
    console.log('Opted in to LP token')
  } catch (e) {
    console.log('Already opted in')
  }

  // Opt-in to USDC token
  try {
    await algorand.send.assetOptIn({
        sender: dispenser.addr,
        assetId: BigInt(usdcAssetId),
    })
    console.log('Opted in to USDC')
  } catch (e) {
    console.log('Already opted in to USDC')
  }

  const depositAmount = 1_000_000n * 1_000_000n // 1M USDC

  // Build AXFER
  const axfer = await algorand.createTransaction.assetTransfer({
    sender: dispenser.addr,
    receiver: poolAddress,
    assetId: BigInt(usdcAssetId),
    amount: depositAmount,
  })

  console.log('Depositing 1M USDC...')
  await poolClient.send.deposit({
    args: { payment: axfer },
    extraFee: algokit.microAlgo(1000), // Cover inner txn fee
  })

  console.log('Deposit successful!')
}

fundPool().catch(console.error)
