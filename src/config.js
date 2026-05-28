import "dotenv/config";
import { ethers } from "ethers";
import { NETWORK, WBNB } from "./addresses.js";

const env = process.env;

const required = ["BSC_WSS_URL", "PRIVATE_KEY", "TARGET_TOKEN", "AMOUNT_IN_BNB", "MAX_PRICE_BNB_PER_TOKEN"];
for (const k of required) {
  if (!env[k]) throw new Error(`.env 누락: ${k}`);
}

const decimals     = Number(env.TARGET_TOKEN_DECIMALS ?? "18");
const amountInWei  = ethers.parseEther(env.AMOUNT_IN_BNB);
const maxPriceWei  = ethers.parseEther(env.MAX_PRICE_BNB_PER_TOKEN);
const ONE_TOKEN    = 10n ** BigInt(decimals);
const amountOutMin = (amountInWei * ONE_TOKEN) / maxPriceWei;

export const config = {
  network: NETWORK,
  wssUrl:  env.BSC_WSS_URL,
  httpUrl: env.BSC_HTTP_URL,
  privateKey: env.PRIVATE_KEY,
  targetToken: ethers.getAddress(env.TARGET_TOKEN),
  wbnb: ethers.getAddress(WBNB),
  decimals,
  amountInBnbStr: env.AMOUNT_IN_BNB,
  maxPriceStr: env.MAX_PRICE_BNB_PER_TOKEN,
  amountInWei,
  amountOutMin,
  gasPriceGwei: env.GAS_PRICE_GWEI ?? "5",
  gasLimit: BigInt(env.GAS_LIMIT ?? "500000"),
  deadlineSeconds: Number(env.DEADLINE_SECONDS ?? "60"),
  dryRun: (env.DRY_RUN ?? "false").toLowerCase() === "true"
};

export function printConfig() {
  console.log("=== Snipe config ===");
  console.log("network:     ", config.network);
  console.log("target:      ", config.targetToken);
  console.log("amountIn:    ", config.amountInBnbStr, "BNB");
  console.log("maxPrice:    ", config.maxPriceStr, "BNB/token");
  console.log("amountOutMin:", ethers.formatUnits(config.amountOutMin, config.decimals), "tokens");
  console.log("gasPrice:    ", config.gasPriceGwei, "gwei");
  console.log("dryRun:      ", config.dryRun);
  console.log();
}
