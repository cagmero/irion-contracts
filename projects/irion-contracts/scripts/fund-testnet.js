require('dotenv').config();
const algokit = require('@algorandfoundation/algokit-utils');
const { AlgorandClient } = algokit;
const { LendingPoolClient } = require('../smart_contracts/artifacts/lending_pool/LendingPoolClient');
const algosdk = require('algosdk');

async function fundTestnet() {
  const algorand = AlgorandClient.fromEnvironment();
  const deployer = await algorand.account.fromEnvironment('DEPLOYER');
  
  const usdcAssetId = 758823248n;
  const poolAppId = 758823264;
  const poolAddress = 'FTP2A7RJLMCHY6R67JDHWKJUJWTQXIFI2DQ3ZN5APVMIJEK2QOLYX7NDAE';
  
  console.log('Deployer:', deployer.addr);

  // 3. Fund Pool with 1 Million USDC (matches LP token supply)
  console.log('Funding Pool with 1M USDC...');
  const poolClient = new LendingPoolClient({
    appId: BigInt(poolAppId),
    algorand: algorand,
    defaultSender: deployer.addr,
  });

  // Opt-in deployer to LP token
  try {
    const info = await algorand.client.algod.accountInformation(poolAddress).do();
    const lpTokenId = info['created-assets']?.[0]?.index || info.createdAssets?.[0]?.index;
    if (lpTokenId) {
        console.log('Detected LP Token ID:', lpTokenId);
        await algorand.send.assetOptIn({
            sender: deployer.addr,
            assetId: BigInt(lpTokenId),
        });
    }
  } catch (e) {
    console.log('Could not detect or opt-in to LP Token:', e.message);
  }

  const depositAmount = 1_000_000n * 1_000_000n; // 1M USDC

  const axfer = await algorand.createTransaction.assetTransfer({
    sender: deployer.addr,
    receiver: poolAddress,
    assetId: usdcAssetId,
    amount: depositAmount,
  });

  await poolClient.send.deposit({
    args: { payment: axfer },
    extraFee: algokit.microAlgo(1000),
  });

  console.log('Testnet Pool funded!');
}

fundTestnet().catch(console.error);
