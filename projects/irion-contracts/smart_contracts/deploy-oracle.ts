import { AlgorandClient, microAlgo } from "@algorandfoundation/algokit-utils";
import algosdk from "algosdk";
import { CreditOracleFactory } from "./artifacts/credit_oracle/CreditOracleClient";

async function main() {
  const algorand = AlgorandClient.fromEnvironment();
  const deployer = await algorand.account.fromEnvironment("DEPLOYER");
  console.log("Deployer:", deployer.addr.toString());

  const factory = algorand.client.getTypedAppFactory(CreditOracleFactory, {
    defaultSender: deployer.addr,
  });
  const { appClient } = await factory.send.create.create();
  const appId = appClient.appId;
  const appAddr = algosdk.getApplicationAddress(appId);
  console.log("New CreditOracle App ID:", appId);

  await algorand.send.payment({
    sender: deployer.addr,
    receiver: appAddr,
    amount: microAlgo(500_000),
  });

  const deployerAddrBytes = algosdk.decodeAddress(deployer.addr.toString()).publicKey;

  await appClient.send.bootstrap({
    args: [deployerAddrBytes, BigInt(762889354), BigInt(762889263)],
    accounts: [deployer.addr.toString()],
  });
  console.log("✓ Bootstrapped");
  console.log("NEW CREDIT_ORACLE_APP_ID=" + appId);
}

main().catch(console.error);
