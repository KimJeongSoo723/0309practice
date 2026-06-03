import "dotenv/config";
import { ethers } from "ethers";
import { NETWORK, WBNB } from "./addresses.js";

const env = process.env;

// 매도 봇에 꼭 필요한 값들.
const required = ["BSC_HTTP_URL", "PRIVATE_KEY", "TOKEN_TO_SELL"];
for (const k of required) {
  if (!env[k]) throw new Error(`.env 누락: ${k}`);
}

// 시작 시 보유 물량을 몇 등분해서 팔지. 기본 100분할.
const splitCount = Number(env.SPLIT_COUNT ?? "100");
if (!Number.isInteger(splitCount) || splitCount < 1) {
  throw new Error(`SPLIT_COUNT 설정 오류 (1 이상 정수): ${env.SPLIT_COUNT}`);
}

const intervalMin = Number(env.INTERVAL_MIN_SECONDS ?? "30");
const intervalMax = Number(env.INTERVAL_MAX_SECONDS ?? "90");

export const config = {
  network: NETWORK,
  httpUrl: env.BSC_HTTP_URL,
  privateKey: env.PRIVATE_KEY,

  tokenToSell: ethers.getAddress(env.TOKEN_TO_SELL),
  wbnb: ethers.getAddress(WBNB),

  // 시작 잔액을 splitCount 등분 -> 매 회차 1/splitCount 씩 매도. 받는 자산은 네이티브 BNB.
  splitCount,

  // 슬리피지 허용치 (bps). 200 = 2%. getAmountsOut 으로 청크 시세 추정 후 적용.
  slippageBps: BigInt(env.SLIPPAGE_BPS ?? "200"),

  // fee-on-transfer(전송세) 토큰이면 true. 확실치 않으면 true 가 안전.
  feeOnTransfer: (env.FEE_ON_TRANSFER ?? "true").toLowerCase() === "true",

  // 매도 사이 대기 시간 (초). [min, max] 무작위.
  intervalMinSeconds: intervalMin,
  intervalMaxSeconds: Math.max(intervalMin, intervalMax),

  gasPriceGwei: env.GAS_PRICE_GWEI ?? "1",
  gasLimit: BigInt(env.GAS_LIMIT ?? "500000"),
  deadlineSeconds: Number(env.DEADLINE_SECONDS ?? "120"),
  dryRun: (env.DRY_RUN ?? "true").toLowerCase() === "true"
};

export function printSellConfig() {
  console.log("=== Sell config ===");
  console.log("network:      ", config.network);
  console.log("tokenToSell:  ", config.tokenToSell);
  console.log("receive:      ", "BNB (네이티브)");
  console.log("path:         ", "TOKEN -> WBNB");
  console.log("strategy:     ", `시작 잔액 ${config.splitCount} 등분 매도`);
  console.log("slippage:     ", `${Number(config.slippageBps) / 100}%`);
  console.log("feeOnTransfer:", config.feeOnTransfer);
  console.log("interval:     ", `${config.intervalMinSeconds} ~ ${config.intervalMaxSeconds}s`);
  console.log("gasPrice:     ", config.gasPriceGwei, "gwei");
  console.log("dryRun:       ", config.dryRun);
  console.log();
}
