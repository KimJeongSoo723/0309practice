import { ethers } from "ethers";
import { config } from "./sellConfig.js";
import { PANCAKE_V2_FACTORY, PANCAKE_V2_ROUTER, WBNB } from "./addresses.js";
import { FACTORY_ABI, PAIR_ABI, ROUTER_ABI, ERC20_ABI } from "./abi.js";

// 매도 경로(TOKEN -> WBNB) 가 실제로 거래 가능한지 진단하는 스크립트.
// getAmountsIn 실패 원인을 찾기 위함. `npm run diag` 로 실행.

const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955"; // 참고용

const provider = new ethers.JsonRpcProvider(config.httpUrl);
const factory  = new ethers.Contract(PANCAKE_V2_FACTORY, FACTORY_ABI, provider);
const router   = new ethers.Contract(PANCAKE_V2_ROUTER, ROUTER_ABI, provider);
const token    = new ethers.Contract(config.tokenToSell, ERC20_ABI, provider);

const TOKEN = config.tokenToSell;

async function pairInfo(label, other, otherLabel, tokenDecimals, otherDecimals) {
  const pair = await factory.getPair(TOKEN, other);
  if (pair === ethers.ZeroAddress) {
    console.log(`  ${label}: ❌ 풀 없음 (PancakeSwap V2 에 ${otherLabel} 페어 미존재)`);
    return null;
  }
  const c = new ethers.Contract(pair, PAIR_ABI, provider);
  const [r, t0] = await Promise.all([c.getReserves(), c.token0()]);
  const tokenIsT0 = t0.toLowerCase() === TOKEN.toLowerCase();
  const reserveToken = tokenIsT0 ? r[0] : r[1];
  const reserveOther = tokenIsT0 ? r[1] : r[0];
  console.log(`  ${label}: ✅ pair ${pair}`);
  console.log(`      유동성: ${ethers.formatUnits(reserveToken, tokenDecimals)} TOKEN  /  ${ethers.formatUnits(reserveOther, otherDecimals)} ${otherLabel}`);
  return { reserveToken, reserveOther };
}

async function main() {
  const net = await provider.getNetwork();
  console.log("chainId:", net.chainId.toString(), "(BSC=56)");
  console.log("token  :", TOKEN);

  let decimals = 18, symbol = "TOKEN";
  try {
    [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
    decimals = Number(decimals);
    console.log("symbol :", symbol, "/ decimals:", decimals);
  } catch (e) {
    console.log("⚠️  decimals/symbol 조회 실패 — 토큰 컨트랙트 주소가 맞는지 확인:", e.shortMessage ?? e.message);
  }

  console.log("\n=== 풀 존재 여부 ===");
  const wbnbPool = await pairInfo("TOKEN/WBNB", WBNB, "WBNB", decimals, 18);
  await pairInfo("TOKEN/USDT", BSC_USDT, "USDT", decimals, 18).catch(() => {});

  console.log("\n=== 매도 경로 시뮬레이션 (TOKEN -> WBNB) ===");
  const path = [TOKEN, WBNB];

  // 1) 토큰 1개를 팔면 BNB 얼마?
  try {
    const out1 = await router.getAmountsOut(ethers.parseUnits("1", decimals), path);
    console.log(`  1 ${symbol} -> ${ethers.formatEther(out1[out1.length - 1])} BNB`);
  } catch (e) {
    console.log("  ❌ getAmountsOut(1 토큰) 실패:", e.shortMessage ?? e.message);
  }

  // 2) 목표: minBnb / maxBnb 를 받으려면 토큰 몇 개? (실패 지점 재현)
  for (const bnbStr of [config.minBnbStr, config.maxBnbStr]) {
    try {
      const need = await router.getAmountsIn(ethers.parseEther(bnbStr), path);
      console.log(`  ${bnbStr} BNB 받기 -> ${ethers.formatUnits(need[0], decimals)} ${symbol} 필요`);
    } catch (e) {
      console.log(`  ❌ getAmountsIn(${bnbStr} BNB) 실패: ${e.shortMessage ?? e.message}`);
      if (wbnbPool) {
        const maxOut = ethers.formatEther(wbnbPool.reserveOther);
        console.log(`     → 풀의 WBNB 보유량이 ${maxOut} BNB 뿐이라, 그보다 큰 출력은 불가능할 수 있음`);
      }
    }
  }

  console.log("\n=== 진단 요약 ===");
  if (!wbnbPool) {
    console.log("• TOKEN/WBNB 직접 풀이 없습니다. 이게 getAmountsIn 실패의 원인입니다.");
    console.log("  해결: USDT 등 다른 페어를 경유해야 합니다 (멀티홉 경로 필요). 알려주시면 코드 추가해드립니다.");
  } else {
    console.log("• TOKEN/WBNB 풀은 존재합니다. 실패했다면 목표 BNB 가 풀 유동성보다 크거나(슬리피지 한계),");
    console.log("  토큰 컨트랙트 특성(전송세 등) 때문일 수 있습니다. 위 시뮬레이션 결과를 확인하세요.");
  }
}

main()
  .catch((e) => { console.error("진단 오류:", e); process.exitCode = 1; })
  .finally(() => provider.destroy?.());
