import "dotenv/config";
import { ethers } from "ethers";
import { NETWORK, WBNB, USDT } from "./addresses.js";

const env = process.env;

// 매도 봇에 꼭 필요한 값들.
const required = ["BSC_HTTP_URL", "PRIVATE_KEY", "TOKEN_TO_SELL"];
for (const k of required) {
  if (!env[k]) throw new Error(`.env 누락: ${k}`);
}

const usdtAddress = env.USDT_ADDRESS || USDT;
if (!usdtAddress) {
  throw new Error(".env 누락: USDT_ADDRESS (이 네트워크엔 기본 USDT 주소가 없습니다)");
}

const minUsdt = Number(env.MIN_USDT ?? "50");
const maxUsdt = Number(env.MAX_USDT ?? "100");
if (!(minUsdt > 0) || !(maxUsdt >= minUsdt)) {
  throw new Error(`MIN_USDT / MAX_USDT 설정 오류: ${minUsdt} ~ ${maxUsdt}`);
}

const intervalMin = Number(env.INTERVAL_MIN_SECONDS ?? "30");
const intervalMax = Number(env.INTERVAL_MAX_SECONDS ?? "90");

export const config = {
  network: NETWORK,
  httpUrl: env.BSC_HTTP_URL,
  privateKey: env.PRIVATE_KEY,

  tokenToSell: ethers.getAddress(env.TOKEN_TO_SELL),
  usdt: ethers.getAddress(usdtAddress),
  wbnb: ethers.getAddress(WBNB),

  // 1회 매도 규모 (USDT 상당). 매번 [min, max] 사이에서 무작위 선택.
  minUsdt,
  maxUsdt,

  // true 면 매도 대금을 USDT 대신 네이티브 BNB 로 받음 (TOKEN -> WBNB, swapExactTokensForETH).
  // 매도 규모(50~100)는 그대로 USDT 가치 기준으로 산정.
  sellToBnb: (env.SELL_TO_BNB ?? "false").toLowerCase() === "true",

  // 가격 산정 경로에서 TOKEN -> WBNB -> USDT 로 경유할지 여부. false 면 TOKEN -> USDT 직접.
  routeThroughWbnb: (env.ROUTE_THROUGH_WBNB ?? "false").toLowerCase() === "true",

  // 슬리피지 허용치 (bps). 200 = 2%.
  slippageBps: BigInt(env.SLIPPAGE_BPS ?? "200"),

  // fee-on-transfer(전송세) 토큰이면 true. 확실치 않으면 true 가 안전.
  feeOnTransfer: (env.FEE_ON_TRANSFER ?? "true").toLowerCase() === "true",

  // 매도 사이 대기 시간 (초). [min, max] 무작위.
  intervalMinSeconds: intervalMin,
  intervalMaxSeconds: Math.max(intervalMin, intervalMax),

  // 총 매도 횟수 상한. 0 이면 무제한(잔액 소진까지).
  maxSells: Number(env.MAX_SELLS ?? "0"),

  // 토큰 잔액이 이 값(USDT 상당) 밑으로 떨어지면 정지.
  stopBelowUsdt: Number(env.STOP_BELOW_USDT ?? "5"),

  gasPriceGwei: env.GAS_PRICE_GWEI ?? "1",
  gasLimit: BigInt(env.GAS_LIMIT ?? "500000"),
  deadlineSeconds: Number(env.DEADLINE_SECONDS ?? "120"),
  dryRun: (env.DRY_RUN ?? "true").toLowerCase() === "true"
};

export function printSellConfig() {
  console.log("=== Sell config ===");
  console.log("network:      ", config.network);
  console.log("tokenToSell:  ", config.tokenToSell);
  console.log("usdt:         ", config.usdt);
  console.log("receive:      ", config.sellToBnb ? "BNB (네이티브)" : "USDT");
  console.log("pricePath:    ", config.routeThroughWbnb ? "TOKEN -> WBNB -> USDT" : "TOKEN -> USDT");
  console.log("sellPath:     ", config.sellToBnb
    ? "TOKEN -> WBNB"
    : (config.routeThroughWbnb ? "TOKEN -> WBNB -> USDT" : "TOKEN -> USDT"));
  console.log("perSell:      ", `${config.minUsdt} ~ ${config.maxUsdt} USDT`);
  console.log("slippage:     ", `${Number(config.slippageBps) / 100}%`);
  console.log("feeOnTransfer:", config.feeOnTransfer);
  console.log("interval:     ", `${config.intervalMinSeconds} ~ ${config.intervalMaxSeconds}s`);
  console.log("maxSells:     ", config.maxSells === 0 ? "무제한" : config.maxSells);
  console.log("stopBelow:    ", `${config.stopBelowUsdt} USDT`);
  console.log("gasPrice:     ", config.gasPriceGwei, "gwei");
  console.log("dryRun:       ", config.dryRun);
  console.log();
}
