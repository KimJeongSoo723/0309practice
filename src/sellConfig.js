import "dotenv/config";
import { ethers } from "ethers";
import { NETWORK, WBNB } from "./addresses.js";

const env = process.env;

// 매도 봇에 꼭 필요한 값들.
const required = ["BSC_HTTP_URL", "PRIVATE_KEY", "TOKEN_TO_SELL"];
for (const k of required) {
  if (!env[k]) throw new Error(`.env 누락: ${k}`);
}

// 1회 매도 규모를 WBNB(=BNB) 로 지정. 매번 [min, max] 사이에서 무작위 선택.
const minBnb = Number(env.MIN_BNB ?? "0.1");
const maxBnb = Number(env.MAX_BNB ?? "0.2");
if (!(minBnb > 0) || !(maxBnb >= minBnb)) {
  throw new Error(`MIN_BNB / MAX_BNB 설정 오류: ${minBnb} ~ ${maxBnb}`);
}

const intervalMin = Number(env.INTERVAL_MIN_SECONDS ?? "30");
const intervalMax = Number(env.INTERVAL_MAX_SECONDS ?? "90");

export const config = {
  network: NETWORK,
  httpUrl: env.BSC_HTTP_URL,
  privateKey: env.PRIVATE_KEY,

  tokenToSell: ethers.getAddress(env.TOKEN_TO_SELL),
  wbnb: ethers.getAddress(WBNB),

  // 1회 매도 규모 (BNB). 매번 이 구간에서 무작위. 받는 자산도 네이티브 BNB.
  minBnb,
  maxBnb,
  minBnbStr: String(minBnb),
  maxBnbStr: String(maxBnb),

  // 슬리피지 허용치 (bps). 200 = 2%.
  slippageBps: BigInt(env.SLIPPAGE_BPS ?? "200"),

  // fee-on-transfer(전송세) 토큰이면 true. 확실치 않으면 true 가 안전.
  feeOnTransfer: (env.FEE_ON_TRANSFER ?? "true").toLowerCase() === "true",

  // 매도 사이 대기 시간 (초). [min, max] 무작위.
  intervalMinSeconds: intervalMin,
  intervalMaxSeconds: Math.max(intervalMin, intervalMax),

  // 총 매도 횟수 상한. 0 이면 무제한(잔액 소진까지).
  maxSells: Number(env.MAX_SELLS ?? "0"),

  // 토큰 잔액의 가치가 이 값(BNB) 밑으로 떨어지면 정지.
  stopBelowBnb: Number(env.STOP_BELOW_BNB ?? "0.01"),

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
  console.log("perSell:      ", `${config.minBnbStr} ~ ${config.maxBnbStr} BNB`);
  console.log("slippage:     ", `${Number(config.slippageBps) / 100}%`);
  console.log("feeOnTransfer:", config.feeOnTransfer);
  console.log("interval:     ", `${config.intervalMinSeconds} ~ ${config.intervalMaxSeconds}s`);
  console.log("maxSells:     ", config.maxSells === 0 ? "무제한" : config.maxSells);
  console.log("stopBelow:    ", `${config.stopBelowBnb} BNB`);
  console.log("gasPrice:     ", config.gasPriceGwei, "gwei");
  console.log("dryRun:       ", config.dryRun);
  console.log();
}
