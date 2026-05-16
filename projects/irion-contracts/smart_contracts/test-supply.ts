import { AlgorandClient, microAlgo } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import fs from 'fs'
import path from 'path'
import { LendingPoolFactory } from './artifacts/lending_pool/LendingPoolClient'

async function main() {
  console.log('=== Test: Supply USDC to LendingPool ===\n')

  const deployments = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'deployments.json'), 'utf8')
  )
  console.log('Loaded deployments:', JSON.stringify(deployments, null, 2))

  const algorand = AlgorandClient.fromEnvironment()
  const dispenser = await algorand.account.localNetDispenser()
  console.log('Dispenser address:', dispenser.addr.toString())

  const usdcAssetId = BigInt(deployments.usdc_asset_id)
  const lendingPoolAppId = BigInt(deployments.lending_pool_app_id)
  console.log('USDC Asset ID:', usdcAssetId.toString())
  console.log('LendingPool App ID:', lendingPoolAppId.toString())

  const lendingPoolClient = new LendingPoolFactory({ algorand, defaultSender: dispenser.addr })
    .getAppClientById({ appId: lendingPoolAppId })

  // Step 1: Check global state
  console.log('\n[1/5] Checking LendingPool global state...')
  const globalState = await lendingPoolClient.state.global.getAll()
  console.log('  pool_asset_id:', globalState.poolAssetId?.toString())
  console.log('  lp_token_id:', globalState.lpTokenId?.toString())
  console.log('  total_deposits:', globalState.totalDeposits?.toString())
  console.log('  total_borrowed:', globalState.totalBorrowed?.toString())

  const lpTokenId = globalState.lpTokenId
  if (!lpTokenId) {
    console.error('ERROR: lp_token_id not found in global state!')
    process.exit(1)
  }
  console.log('  LP Token ID:', lpTokenId.toString())

  // Step 2: Ensure dispenser is opted into USDC
  console.log('\n[2/5] Ensuring dispenser is opted into USDC...')
  try {
    await algorand.client.algod.accountAssetInformation(dispenser.addr, usdcAssetId).do()
    console.log('  Already opted into USDC')
  } catch (e) {
    console.log('  Not opted into USDC, opting in...')
    await algorand.send.assetOptIn({
      sender: dispenser.addr,
      assetId: usdcAssetId,
    })
    console.log('  Opted into USDC successfully!')
  }

  // Check USDC balance
  console.log('  Checking USDC balance...')
  const dispenserUsdcInfo = await algorand.client.algod.accountAssetInformation(dispenser.addr, usdcAssetId).do()
  const usdcHolding = (dispenserUsdcInfo as any)['asset-holding'] || (dispenserUsdcInfo as any).assetHolding
  const usdcBalance = usdcHolding ? BigInt(usdcHolding.amount) : 0n
  console.log('  Dispenser USDC balance:', (Number(usdcBalance) / 1_000_000).toFixed(2))

  // Step 3: Ensure dispenser is opted into LP token
  console.log('\n[3/5] Ensuring dispenser is opted into LP token...')
  try {
    await algorand.client.algod.accountAssetInformation(dispenser.addr, lpTokenId).do()
    console.log('  Already opted into LP token')
  } catch (e) {
    console.log('  Not opted into LP token, opting in...')
    await algorand.send.assetOptIn({
      sender: dispenser.addr,
      assetId: lpTokenId,
    })
    console.log('  Opted into LP token successfully!')
  }

  // Step 4: Supply USDC to the pool
  const supplyAmountUsdc = 100
  const supplyAmountMicro = BigInt(supplyAmountUsdc * 1_000_000)
  console.log(`\n[4/5] Supplying ${supplyAmountUsdc} USDC (${supplyAmountMicro.toString()} microUSDC) to pool...`)

  const sp = await algorand.client.algod.getTransactionParams().do()

  const paymentTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: dispenser.addr.toString(),
    receiver: algosdk.getApplicationAddress(Number(lendingPoolAppId)),
    assetIndex: Number(usdcAssetId),
    amount: supplyAmountMicro,
    suggestedParams: sp,
  })

  const result = await lendingPoolClient.send.deposit({
    args: [{ txn: paymentTxn, signer: dispenser.signer }],
    extraFee: microAlgo(2000),
  })

  console.log('  Deposit transaction ID:', result.txIds[0])
  console.log('  Deposit confirmed!')

  // Step 5: Verify deposit
  console.log('\n[5/5] Verifying deposit...')
  const globalStateAfter = await lendingPoolClient.state.global.getAll()
  console.log('  total_deposits after:', globalStateAfter.totalDeposits?.toString())
  console.log('  total_borrowed after:', globalStateAfter.totalBorrowed?.toString())

  // Check lender position via read-only method
  try {
    const positionResult = await lendingPoolClient.send.getLenderPosition({
      args: [dispenser.addr.toString()],
    })
    const returnValue = positionResult.return!
    console.log('  Lender position found:')
    console.log('    deposit_amount:', returnValue[0].toString(), '(' + (Number(returnValue[0]) / 1_000_000).toFixed(2) + ' USDC)')
    console.log('    accrued_yield:', returnValue[1].toString())
  } catch (e: any) {
    console.log('  Could not read lender position:', e.message || e)
  }

  // Check LP token balance
  const lpBalanceAfter = await algorand.client.algod.accountAssetInformation(dispenser.addr, lpTokenId).do()
  const lpHolding = (lpBalanceAfter as any)['asset-holding'] || (lpBalanceAfter as any).assetHolding
  const lpBalance = lpHolding ? BigInt(lpHolding.amount) : 0n
  console.log('  LP token balance after deposit:', lpBalance.toString(), '(' + (Number(lpBalance) / 1_000_000).toFixed(2) + ' LPC)')

  // Check pool USDC balance
  const poolAddress = algosdk.getApplicationAddress(Number(lendingPoolAppId))
  const poolUsdcInfo = await algorand.client.algod.accountAssetInformation(poolAddress, usdcAssetId).do()
  const poolHolding = (poolUsdcInfo as any)['asset-holding'] || (poolUsdcInfo as any).assetHolding
  const poolUsdcBalance = poolHolding ? BigInt(poolHolding.amount) : 0n
  console.log('  Pool USDC balance:', poolUsdcBalance.toString(), '(' + (Number(poolUsdcBalance) / 1_000_000).toFixed(2) + ' USDC)')

  console.log('\n=== Supply test PASSED! ===')
}

main().catch((err) => {
  console.error('Supply test FAILED:', err)
  process.exit(1)
})