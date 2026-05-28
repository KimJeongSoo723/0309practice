import { ethers } from "ethers";
import { config, printConfig } from "./config.js";

printConfig();

const provider = config.httpUrl
  ? new ethers.JsonRpcProvider(config.httpUrl)
  : new ethers.WebSocketProvider(config.wssUrl);

const wallet = new ethers.Wallet(config.privateKey, provider);

const net = await provider.getNetwork();
console.log("chainId:", net.chainId.toString(), "(BSC mainnet=56, testnet=97)");

const balance = await provider.getBalance(wallet.address);
console.log("wallet :", wallet.address);
console.log("balance:", ethers.formatEther(balance), "BNB");

const required = config.amountInWei + (config.gasLimit * ethers.parseUnits(config.gasPriceGwei, "gwei"));
console.log("필요 최소:", ethers.formatEther(required), "BNB (amountIn + gas 상한)");

if (balance < required) {
  console.error("잔액 부족.");
  process.exit(1);
} else {
  console.log("OK — 잔액 충분.");
}

await provider.destroy?.();
