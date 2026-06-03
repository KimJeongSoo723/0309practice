import { ethers } from "ethers";
import { config, printSellConfig } from "./sellConfig.js";
import { PANCAKE_V2_ROUTER } from "./addresses.js";
import { ROUTER_ABI, ERC20_ABI } from "./abi.js";

printSellConfig();

const provider = new ethers.JsonRpcProvider(config.httpUrl);
const wallet   = new ethers.Wallet(config.privateKey, provider);
const router   = new ethers.Contract(PANCAKE_V2_ROUTER, ROUTER_ABI, wallet);
const token    = new ethers.Contract(config.tokenToSell, ERC20_ABI, wallet);

// 토큰을 팔아 네이티브 BNB 로 받는 경로.
const PATH = [config.tokenToSell, config.wbnb];

let stopRequested = false;
process.on("SIGINT", () => {
  console.log("\n정지 요청됨 — 진행 중인 매도 후 종료합니다.");
  stopRequested = true;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand  = (min, max) => min + Math.random() * (max - min);

// 무작위 BNB 목표액 -> 문자열(소수 6자리). parseEther 입력용.
function pickTargetBnb() {
  return rand(config.minBnb, config.maxBnb).toFixed(6);
}

async function ensureAllowance() {
  const current = await token.allowance(wallet.address, PANCAKE_V2_ROUTER);
  if (current >= ethers.MaxUint256 / 2n) {
    console.log("approve: 이미 충분한 allowance.");
    return;
  }
  if (config.dryRun) {
    console.log("[DRY RUN] approve 필요 (실제 전송 X). allowance:", current.toString());
    return;
  }
  console.log("approve 전송 중 (router 에 매도 권한 부여)...");
  const gasPrice = ethers.parseUnits(config.gasPriceGwei, "gwei");
  const tx = await token.approve(PANCAKE_V2_ROUTER, ethers.MaxUint256, { gasPrice });
  console.log("approve tx:", tx.hash);
  await tx.wait();
  console.log("approve 완료.\n");
}

async function sellOnce(tokenDecimals, tokenSymbol) {
  const balance = await token.balanceOf(wallet.address);

  // 목표 BNB 액수에 해당하는 토큰 수량 계산.
  const targetBnbStr = pickTargetBnb();
  const targetBnbWei = ethers.parseEther(targetBnbStr);

  let amountIn;
  try {
    const amountsIn = await router.getAmountsIn(targetBnbWei, PATH);
    amountIn = amountsIn[0];
  } catch (err) {
    console.error(`getAmountsIn 실패 (목표 ${targetBnbStr} BNB, 경로 TOKEN->WBNB):`, err.shortMessage ?? err.message);
    console.error("  → 원인 진단: `npm run diag` 실행해보세요 (TOKEN/WBNB 풀 존재/유동성 확인).");
    return { sold: false, balance };
  }

  // 잔액보다 많이 필요하면 남은 잔액 전량 매도.
  if (amountIn > balance) {
    console.log(`목표 ${targetBnbStr} BNB 에 필요한 토큰이 잔액보다 큼 -> 남은 전량 매도`);
    amountIn = balance;
  }
  if (amountIn === 0n) return { sold: false, balance };

  // 실제 받게 될 BNB 추정 -> 슬리피지 적용해 amountOutMin 산정.
  const amountsOut  = await router.getAmountsOut(amountIn, PATH);
  const expectedOut = amountsOut[amountsOut.length - 1];
  const amountOutMin = (expectedOut * (10000n - config.slippageBps)) / 10000n;

  const inStr  = ethers.formatUnits(amountIn, tokenDecimals);
  const outStr = ethers.formatEther(expectedOut);
  const minStr = ethers.formatEther(amountOutMin);
  console.log(`매도: ${inStr} ${tokenSymbol}  ->  ~${outStr} BNB (최소 ${minStr})`);

  const deadline  = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
  const gasPrice  = ethers.parseUnits(config.gasPriceGwei, "gwei");
  const overrides = { gasPrice, gasLimit: config.gasLimit };
  const fn = config.feeOnTransfer
    ? "swapExactTokensForETHSupportingFeeOnTransferTokens"
    : "swapExactTokensForETH";
  const args = [amountIn, amountOutMin, PATH, wallet.address, deadline];

  if (config.dryRun) {
    const data = router.interface.encodeFunctionData(fn, args);
    await provider.call({ from: wallet.address, to: PANCAKE_V2_ROUTER, data });
    console.log("[DRY RUN] 시뮬레이션 통과 — tx 전송 안 함\n");
    return { sold: true, balance: balance - amountIn };
  }

  const tx = await router[fn](...args, overrides);
  console.log("tx 전송:", tx.hash);
  const receipt = await tx.wait();
  console.log("블록", receipt.blockNumber, "확정 status:", receipt.status, "\n");
  return { sold: receipt.status === 1, balance: balance - amountIn };
}

async function main() {
  const net = await provider.getNetwork();
  console.log("chainId:", net.chainId.toString(), "(BSC mainnet=56, testnet=97)");
  console.log("wallet :", wallet.address);

  const [tokenDecimals, tokenSymbol, bnb, balance] = await Promise.all([
    token.decimals(),
    token.symbol().catch(() => "TOKEN"),
    provider.getBalance(wallet.address),
    token.balanceOf(wallet.address)
  ]);
  const td = Number(tokenDecimals);

  console.log("BNB(gas):", ethers.formatEther(bnb), "BNB");
  console.log("보유토큰:", ethers.formatUnits(balance, td), tokenSymbol);

  if (balance === 0n) {
    console.error("보유 토큰이 0 입니다. 종료.");
    return;
  }
  if (bnb === 0n && !config.dryRun) {
    console.error("가스용 BNB 가 0 입니다. 종료.");
    return;
  }
  console.log();

  await ensureAllowance();

  // stopBelowBnb 를 토큰 수량으로 환산 (대략).
  let stopBelowTokens = 0n;
  try {
    const stopWei = ethers.parseEther(String(config.stopBelowBnb));
    const inForStop = await router.getAmountsIn(stopWei, PATH);
    stopBelowTokens = inForStop[0];
  } catch { /* 무시 — 잔액 0 까지 */ }

  let count = 0;
  while (!stopRequested) {
    if (config.maxSells > 0 && count >= config.maxSells) {
      console.log(`최대 매도 횟수(${config.maxSells}) 도달 — 종료.`);
      break;
    }

    const result = await sellOnce(td, tokenSymbol).catch((err) => {
      console.error("매도 실패:", err.shortMessage ?? err.message, "\n");
      return { sold: false, balance: null };
    });

    if (result.sold) count++;

    // 잔액 소진 체크.
    const live = await token.balanceOf(wallet.address);
    if (live <= stopBelowTokens) {
      console.log(`잔액이 정지 기준(${config.stopBelowBnb} BNB 상당) 이하 -> 종료. 총 ${count}회 매도.`);
      break;
    }

    if (stopRequested) break;

    const waitMs = Math.floor(rand(config.intervalMinSeconds, config.intervalMaxSeconds) * 1000);
    console.log(`다음 매도까지 ${(waitMs / 1000).toFixed(0)}초 대기... (지금까지 ${count}회)\n`);
    await sleep(waitMs);
  }

  console.log("종료. 총 매도 횟수:", count);
}

main()
  .catch((err) => {
    console.error("치명적 오류:", err);
    process.exitCode = 1;
  })
  .finally(() => provider.destroy?.());
