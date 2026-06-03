import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";
import { GraphQLClient } from "graphql-request";
import {
  ChainId,
  ERC20Token,
  Native,
  CurrencyAmount,
  TradeType
} from "@pancakeswap/sdk";
import { SmartRouter } from "@pancakeswap/smart-router";
import { v4config } from "./v4Config.js";

// === 1단계: 견적 전용 ===
// "시작 잔액의 1/SPLIT_COUNT 청크를 팔면 BNB 얼마 받나"를 Infinity 포함 전체 풀에서 라우팅.
// 실거래는 하지 않음. 이 출력/에러로 SDK API 형태를 확정한 뒤 실행부(sellV4.js)를 마무리.

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }
];

const publicClient = createPublicClient({
  chain: bsc,
  transport: http(v4config.rpcUrl),
  batch: { multicall: { batchSize: 1024 * 200, wait: 16 } }
});

const onChainProvider = () => publicClient;

async function fetchCandidatePools(currencyA, currencyB) {
  const v2Sub = v4config.v2Subgraph ? new GraphQLClient(v4config.v2Subgraph) : undefined;
  const v3Sub = v4config.v3Subgraph ? new GraphQLClient(v4config.v3Subgraph) : undefined;
  const infSub = v4config.infinitySubgraph ? new GraphQLClient(v4config.infinitySubgraph) : undefined;

  const results = {};
  const pools = [];

  // 각 풀 타입을 개별 try/catch 로 감싸 어떤 게 되는지 진단.
  try {
    const v2 = await SmartRouter.getV2CandidatePools({
      onChainProvider,
      v2SubgraphProvider: v2Sub ? () => v2Sub : undefined,
      v3SubgraphProvider: v3Sub ? () => v3Sub : undefined,
      currencyA,
      currencyB
    });
    results.v2 = v2.length;
    pools.push(...v2);
  } catch (e) {
    results.v2 = `실패: ${e.shortMessage ?? e.message}`;
  }

  try {
    const v3 = await SmartRouter.getV3CandidatePools({
      onChainProvider,
      subgraphProvider: v3Sub ? () => v3Sub : undefined,
      currencyA,
      currencyB
    });
    results.v3 = v3.length;
    pools.push(...v3);
  } catch (e) {
    results.v3 = `실패: ${e.shortMessage ?? e.message}`;
  }

  // Infinity(v4) 후보 풀 — SDK 버전에 따라 함수명이 다를 수 있어 가용한 것을 탐색.
  const infinityFns = [
    "getInfinityCandidatePools",
    "getInfinityClCandidatePools",
    "getInfinityCandidatePoolsWithoutBins",
    "getV4CandidatePools"
  ];
  let infinityDone = false;
  for (const fnName of infinityFns) {
    if (typeof SmartRouter[fnName] === "function") {
      try {
        const inf = await SmartRouter[fnName]({
          onChainProvider,
          subgraphProvider: infSub ? () => infSub : undefined,
          currencyA,
          currencyB
        });
        results[`infinity(${fnName})`] = inf.length;
        pools.push(...inf);
        infinityDone = true;
        break;
      } catch (e) {
        results[`infinity(${fnName})`] = `실패: ${e.shortMessage ?? e.message}`;
      }
    }
  }
  if (!infinityDone) {
    results.infinity = `SDK에 Infinity 후보풀 함수 없음 — 사용가능 키: ${Object.keys(SmartRouter).filter((k) => /infinity|v4/i.test(k)).join(", ") || "(없음)"}`;
  }

  return { pools, results };
}

async function main() {
  console.log("=== Smart Router 견적 (Infinity 포함) ===");
  console.log("chainId:", v4config.chainId, "(BSC)");
  console.log("token  :", v4config.tokenToSell);

  const cid = ChainId.BSC;
  let decimals = v4config.tokenDecimals;
  let symbol = "TOKEN";
  try {
    [decimals, symbol] = await Promise.all([
      publicClient.readContract({ address: v4config.tokenToSell, abi: ERC20_ABI, functionName: "decimals" }),
      publicClient.readContract({ address: v4config.tokenToSell, abi: ERC20_ABI, functionName: "symbol" })
    ]);
    decimals = Number(decimals);
    console.log("symbol :", symbol, "/ decimals:", decimals);
  } catch (e) {
    console.log("⚠️ decimals/symbol 조회 실패:", e.shortMessage ?? e.message);
  }

  const token = new ERC20Token(cid, v4config.tokenToSell, decimals, symbol);
  const native = Native.onChain(cid);

  // 청크 산정: 잔액/SPLIT. 잔액 0 이거나 키 없으면 임의 1토큰으로 견적.
  let chunkRaw;
  try {
    const owner = v4config.privateKey
      ? (await import("viem/accounts")).privateKeyToAccount(v4config.privateKey).address
      : null;
    if (owner) {
      const bal = await publicClient.readContract({ address: v4config.tokenToSell, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] });
      console.log("wallet :", owner);
      console.log("보유   :", bal.toString(), "(raw)");
      chunkRaw = bal / BigInt(v4config.splitCount);
    }
  } catch (e) {
    console.log("(잔액 조회 생략:", e.shortMessage ?? e.message, ")");
  }
  if (!chunkRaw || chunkRaw === 0n) {
    chunkRaw = 10n ** BigInt(decimals); // 1 토큰으로 견적
    console.log("→ 잔액/키 없음 또는 0 — 견적용으로 1 토큰 사용");
  }
  console.log("견적 청크:", chunkRaw.toString(), "(raw)\n");

  const amount = CurrencyAmount.fromRawAmount(token, chunkRaw);

  console.log("후보 풀 조회 중...");
  const { pools, results } = await fetchCandidatePools(token, native);
  console.log("풀 조회 결과:", results);
  console.log("총 후보 풀 수:", pools.length, "\n");

  if (pools.length === 0) {
    console.error("후보 풀이 0 개라 라우팅 불가. 위 '풀 조회 결과'를 보고 서브그래프/Infinity 함수 조정 필요.");
    return;
  }

  const quoteProvider = SmartRouter.createQuoteProvider({ onChainProvider });
  const trade = await SmartRouter.getBestTrade(amount, native, TradeType.EXACT_INPUT, {
    gasPriceWei: () => publicClient.getGasPrice(),
    maxHops: v4config.maxHops,
    maxSplits: v4config.maxSplits,
    poolProvider: SmartRouter.createStaticPoolProvider(pools),
    quoteProvider,
    quoterOptimization: true
  });

  if (!trade) {
    console.error("경로를 찾지 못함 (trade=null).");
    return;
  }

  const outRaw = trade.outputAmount.quotient.toString();
  console.log("=== 견적 결과 ===");
  console.log(`입력: ${trade.inputAmount.toExact()} ${symbol}`);
  console.log(`출력: ${trade.outputAmount.toExact()} BNB  (raw ${outRaw})`);
  try {
    console.log("경로:", SmartRouter.getPoolTypes ? trade.routes.map((r) => r.pools.map((p) => p.type).join(">")).join(" | ") : JSON.stringify(trade.routes?.length));
  } catch { /* noop */ }
  console.log("\n✅ 견적 성공 — 이 출력 붙여주시면 실행부(sellV4.js) 마무리하겠습니다.");
}

main().catch((e) => {
  console.error("견적 오류:", e.shortMessage ?? e.message);
  console.error(e.stack?.split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
});
