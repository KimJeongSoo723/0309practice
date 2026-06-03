import "dotenv/config";

// PancakeSwap Smart Router (Infinity/v4 포함) 매도 봇 공용 설정.
// 체인: BSC 메인넷 (chainId 56).

const env = process.env;

const required = ["BSC_HTTP_URL", "TOKEN_TO_SELL"];
for (const k of required) {
  if (!env[k]) throw new Error(`.env 누락: ${k}`);
}

export const v4config = {
  chainId: 56, // BSC
  rpcUrl: env.BSC_HTTP_URL,
  privateKey: env.PRIVATE_KEY, // 견적만 할 땐 없어도 됨
  tokenToSell: env.TOKEN_TO_SELL,
  tokenDecimals: Number(env.TARGET_TOKEN_DECIMALS ?? "18"),
  splitCount: Number(env.SPLIT_COUNT ?? "100"),
  // 슬리피지 (%). 2 = 2%.
  slippagePct: Number(env.SLIPPAGE_PCT ?? "2"),
  maxHops: Number(env.MAX_HOPS ?? "3"),
  maxSplits: Number(env.MAX_SPLITS ?? "2"),
  dryRun: (env.DRY_RUN ?? "true").toLowerCase() === "true",

  // 라우팅에 쓸 서브그래프(있으면 TVL 기반 후보 풀 선별에 사용). 막히면 비워도 온체인으로 시도.
  v2Subgraph: env.V2_SUBGRAPH ?? "",
  v3Subgraph: env.V3_SUBGRAPH ?? "",
  infinitySubgraph: env.INFINITY_SUBGRAPH ?? ""
};
