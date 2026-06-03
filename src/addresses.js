// PancakeSwap V2 contracts.
// 메인넷이 기본값이고, .env 의 NETWORK=testnet 으로 BSC 테스트넷용 주소로 전환 가능.

const MAINNET = {
  factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
  router:  "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  wbnb:    "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  usdt:    "0x55d398326f99059fF775485246999027B3197955" // BSC-USD (18 decimals)
};

const TESTNET = {
  factory: "0x6725F303b657a9451d8BA641348b6761A6CC7a17",
  router:  "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
  wbnb:    "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
  usdt:    "" // 테스트넷엔 표준 USDT가 없음 — .env 의 USDT_ADDRESS 로 지정
};

const network = (process.env.NETWORK ?? "mainnet").toLowerCase();
const set     = network === "testnet" ? TESTNET : MAINNET;

export const PANCAKE_V2_FACTORY = set.factory;
export const PANCAKE_V2_ROUTER  = set.router;
export const WBNB               = set.wbnb;
export const USDT               = set.usdt;
export const NETWORK            = network;
