import "dotenv/config";
import { ethers } from "ethers";
import { PANCAKE_V2_FACTORY, PANCAKE_V2_ROUTER, WBNB } from "./addresses.js";
import { FACTORY_ABI, ROUTER_ABI } from "./abi.js";

const {
  BSC_WSS_URL,
  BSC_HTTP_URL,
  PRIVATE_KEY,
  TARGET_TOKEN,
  TARGET_TOKEN_DECIMALS = "18",
  AMOUNT_IN_BNB,
  MAX_PRICE_BNB_PER_TOKEN,
  GAS_PRICE_GWEI = "5",
  GAS_LIMIT = "500000",
  DEADLINE_SECONDS = "60"
} = process.env;

for (const [k, v] of Object.entries({
  BSC_WSS_URL, PRIVATE_KEY, TARGET_TOKEN, AMOUNT_IN_BNB, MAX_PRICE_BNB_PER_TOKEN
})) {
  if (!v) throw new Error(`.env 누락: ${k}`);
}

const targetToken = ethers.getAddress(TARGET_TOKEN);
const wbnb        = ethers.getAddress(WBNB);
const decimals    = Number(TARGET_TOKEN_DECIMALS);

// amountOutMin 계산: amountInBNB / maxPrice 만큼은 최소한 받아야 한다.
// 풀 실가격이 maxPrice 보다 비싸면 받는 양이 부족해서 라우터가 revert -> 가격 상한 강제.
const amountInWei  = ethers.parseEther(AMOUNT_IN_BNB);
const maxPriceWei  = ethers.parseEther(MAX_PRICE_BNB_PER_TOKEN); // BNB per 1 token, in wei
const ONE_TOKEN    = 10n ** BigInt(decimals);
const amountOutMin = (amountInWei * ONE_TOKEN) / maxPriceWei;

console.log("=== Snipe config ===");
console.log("target:", targetToken);
console.log("amountIn:", AMOUNT_IN_BNB, "BNB");
console.log("maxPrice:", MAX_PRICE_BNB_PER_TOKEN, "BNB/token");
console.log("amountOutMin:", ethers.formatUnits(amountOutMin, decimals), "tokens");

const wsProvider   = new ethers.WebSocketProvider(BSC_WSS_URL);
const httpProvider = BSC_HTTP_URL ? new ethers.JsonRpcProvider(BSC_HTTP_URL) : wsProvider;
const wallet       = new ethers.Wallet(PRIVATE_KEY, httpProvider);
const factory      = new ethers.Contract(PANCAKE_V2_FACTORY, FACTORY_ABI, wsProvider);
const router       = new ethers.Contract(PANCAKE_V2_ROUTER, ROUTER_ABI, wallet);

let executed = false;

async function snipe(pair) {
  if (executed) return;
  executed = true;

  const deadline = Math.floor(Date.now() / 1000) + Number(DEADLINE_SECONDS);
  const path     = [wbnb, targetToken];
  const gasPrice = ethers.parseUnits(GAS_PRICE_GWEI, "gwei");

  console.log(`>>> pair detected: ${pair} — sending buy tx`);

  try {
    const tx = await router.swapExactETHForTokens(
      amountOutMin,
      path,
      wallet.address,
      deadline,
      { value: amountInWei, gasPrice, gasLimit: BigInt(GAS_LIMIT) }
    );
    console.log("tx sent:", tx.hash);
    const receipt = await tx.wait();
    console.log("mined in block", receipt.blockNumber, "status:", receipt.status);
  } catch (err) {
    console.error("buy failed:", err.shortMessage ?? err.message);
    executed = false; // 가격이 너무 높아 revert 된 경우 다시 시도할 수 있게.
  }
}

function isOurPair(token0, token1) {
  const a = token0.toLowerCase();
  const b = token1.toLowerCase();
  const t = targetToken.toLowerCase();
  const w = wbnb.toLowerCase();
  return (a === t && b === w) || (a === w && b === t);
}

console.log("listening for PairCreated on PancakeSwap V2 factory...");
factory.on("PairCreated", async (token0, token1, pair) => {
  if (!isOurPair(token0, token1)) return;
  await snipe(pair);
});

process.on("SIGINT", async () => {
  console.log("\nshutting down...");
  await wsProvider.destroy();
  process.exit(0);
});
