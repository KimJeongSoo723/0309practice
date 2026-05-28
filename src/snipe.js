import { ethers } from "ethers";
import { config, printConfig } from "./config.js";
import { PANCAKE_V2_FACTORY, PANCAKE_V2_ROUTER } from "./addresses.js";
import { FACTORY_ABI, ROUTER_ABI } from "./abi.js";

printConfig();

const wsProvider   = new ethers.WebSocketProvider(config.wssUrl);
const httpProvider = config.httpUrl ? new ethers.JsonRpcProvider(config.httpUrl) : wsProvider;
const wallet       = new ethers.Wallet(config.privateKey, httpProvider);
const factory      = new ethers.Contract(PANCAKE_V2_FACTORY, FACTORY_ABI, wsProvider);
const router       = new ethers.Contract(PANCAKE_V2_ROUTER, ROUTER_ABI, wallet);

console.log("wallet:", wallet.address);
console.log("listening for PairCreated on PancakeSwap V2 factory...\n");

let executed = false;

async function snipe(pair) {
  if (executed) return;
  executed = true;

  const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
  const path     = [config.wbnb, config.targetToken];
  const gasPrice = ethers.parseUnits(config.gasPriceGwei, "gwei");
  const overrides = { value: config.amountInWei, gasPrice, gasLimit: config.gasLimit };

  console.log(`>>> pair detected: ${pair}`);

  try {
    if (config.dryRun) {
      // 실제 송신 대신 eth_call 로 결과만 시뮬레이션.
      const data = router.interface.encodeFunctionData("swapExactETHForTokens", [
        config.amountOutMin, path, wallet.address, deadline
      ]);
      const result = await httpProvider.call({
        from: wallet.address,
        to: PANCAKE_V2_ROUTER,
        value: config.amountInWei,
        data
      });
      const amounts = router.interface.decodeFunctionResult("swapExactETHForTokens", result)[0];
      const got = amounts[amounts.length - 1];
      console.log(`[DRY RUN] would receive ${ethers.formatUnits(got, config.decimals)} tokens — tx NOT sent`);
    } else {
      const tx = await router.swapExactETHForTokens(
        config.amountOutMin, path, wallet.address, deadline, overrides
      );
      console.log("tx sent:", tx.hash);
      const receipt = await tx.wait();
      console.log("mined in block", receipt.blockNumber, "status:", receipt.status);
    }
  } catch (err) {
    console.error("buy failed:", err.shortMessage ?? err.message);
    executed = false; // 가격이 너무 높아 revert 된 경우 다시 시도할 수 있게.
  }
}

function isOurPair(token0, token1) {
  const a = token0.toLowerCase();
  const b = token1.toLowerCase();
  const t = config.targetToken.toLowerCase();
  const w = config.wbnb.toLowerCase();
  return (a === t && b === w) || (a === w && b === t);
}

factory.on("PairCreated", async (token0, token1, pair) => {
  if (!isOurPair(token0, token1)) return;
  await snipe(pair);
});

process.on("SIGINT", async () => {
  console.log("\nshutting down...");
  await wsProvider.destroy();
  process.exit(0);
});
