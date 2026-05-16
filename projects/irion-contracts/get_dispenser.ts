import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'

async function getDispenser() {
  const algorand = AlgorandClient.fromEnvironment()
  const account = await algorand.account.localNetDispenser()
  console.log("MNEMONIC=" + algosdk.secretKeyToMnemonic(account.sk))
}

getDispenser().catch(console.error)
