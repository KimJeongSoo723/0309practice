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

// 청크에 대한 amountOutMin 산정. getAmountsOut 성공하면 슬리피지 적용,
// 실패하면(풀 조회 불가 등) 0 으로 폴백하고 경고.
async function calcMinOut(amountIn, tokenDecimals, tokenSymbol) {
  try {
    const amounts = await router.getAmountsOut(amountIn, PATH);
    const expected = amounts[amounts.length - 1];
    const minOut = (expected * (10000n - config.slippageBps)) / 10000n;
    const inStr  = ethers.formatUnits(amountIn, tokenDecimals);
    console.log(`매도: ${inStr} ${tokenSymbol}  ->  ~${ethers.formatEther(expected)} BNB (최소 ${ethers.formatEther(minOut)})`);
    return minOut;
  } catch (err) {
    console.warn("⚠️  getAmountsOut 실패 -> amountOutMin=0 으로 진행 (슬리피지 보호 없음):", err.shortMessage ?? err.message);
    return 0n;
  }
}

async function sellChunk(amountIn, tokenDecimals, tokenSymbol) {
  if (amountIn === 0n) return false;

  const amountOutMin = await calcMinOut(amountIn, tokenDecimals, tokenSymbol);

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
    return true;
  }

  const tx = await router[fn](...args, overrides);
  console.log("tx 전송:", tx.hash);
  const receipt = await tx.wait();
  console.log("블록", receipt.blockNumber, "확정 status:", receipt.status, "\n");
  return receipt.status === 1;
}

async function main() {
  const net = await provider.getNetwork();
  console.log("chainId:", net.chainId.toString(), "(BSC mainnet=56, testnet=97)");
  console.log("wallet :", wallet.address);

  const [tokenDecimals, tokenSymbol, bnb, startBalance] = await Promise.all([
    token.decimals(),
    token.symbol().catch(() => "TOKEN"),
    provider.getBalance(wallet.address),
    token.balanceOf(wallet.address)
  ]);
  const td = Number(tokenDecimals);

  console.log("BNB(gas):", ethers.formatEther(bnb), "BNB");
  console.log("보유토큰:", ethers.formatUnits(startBalance, td), tokenSymbol);

  if (startBalance === 0n) {
    console.error("보유 토큰이 0 입니다. 종료.");
    return;
  }
  if (bnb === 0n && !config.dryRun) {
    console.error("가스용 BNB 가 0 입니다. 종료.");
    return;
  }

  // 시작 잔액을 splitCount 등분 -> 1회 매도량 고정.
  const chunk = startBalance / BigInt(config.splitCount);
  if (chunk === 0n) {
    console.error(`보유량이 너무 적어 ${config.splitCount} 등분 불가. 종료.`);
    return;
  }
  console.log(`전략: ${ethers.formatUnits(startBalance, td)} ${tokenSymbol} 를 ${config.splitCount} 등분`);
  console.log(`1회 매도량: ${ethers.formatUnits(chunk, td)} ${tokenSymbol}\n`);

  await ensureAllowance();

  let count = 0;
  for (let i = 1; i <= config.splitCount; i++) {
    if (stopRequested) break;

    // 매 회차 직전 실제 잔액 확인 (전송세 등으로 줄었을 수 있음).
    const live = await token.balanceOf(wallet.address);
    if (live === 0n) {
      console.log("잔액 0 -> 종료.");
      break;
    }

    // 마지막 회차이거나 남은 잔액이 청크보다 작으면 전량 매도(잔량 정리).
    const amount = (i === config.splitCount || live < chunk) ? live : chunk;

    console.log(`[${i}/${config.splitCount}]`);
    const ok = await sellChunk(amount, td, tokenSymbol).catch((err) => {
      console.error("매도 실패:", err.shortMessage ?? err.message, "\n");
      return false;
    });
    if (ok) count++;

    if (amount === live) {
      console.log("남은 전량 매도 완료 -> 종료.");
      break;
    }
    if (stopRequested) break;

    const waitMs = Math.floor(rand(config.intervalMinSeconds, config.intervalMaxSeconds) * 1000);
    console.log(`다음 매도까지 ${(waitMs / 1000).toFixed(0)}초 대기...\n`);
    await sleep(waitMs);
  }

  console.log("종료. 성공한 매도 횟수:", count);
}

main()
  .catch((err) => {
    console.error("치명적 오류:", err);
    process.exitCode = 1;
  })
  .finally(() => provider.destroy?.());
