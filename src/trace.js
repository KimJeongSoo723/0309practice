// 토큰 분배 추적기 (BSC) — RPC 전용, API 키 불필요
// 시드 지갑들에서 시작해 특정 토큰의 Transfer 이벤트를 BFS 로 따라가며
// 자금이 흘러간 일반 지갑(EOA) 들을 찾고, 지금도 보유 중인 곳을 표시합니다.
//
// 데이터 소스: BSC 공개 RPC 의 eth_getLogs (Transfer 이벤트). 무료, 키 불필요.
//
// 사용법:
//   .env 에 아래 설정 후  ->  node src/trace.js
//     BSC_HTTP_URL=https://bsc-rpc.publicnode.com   (eth_getLogs 잘 되는 노드 권장)
//     TRACE_TOKEN=0xF39e4b21c84e737Df08e2C3b32541d856f508E48
//     TRACE_MAX_DEPTH=3          (시드에서 몇 홉까지 따라갈지)
//     TRACE_MIN_VALUE=0          (이 값 미만 전송은 노이즈로 무시, 토큰 단위)
//     TRACE_START_BLOCK=0        (토큰 생성 블록을 넣으면 훨씬 빠름. 모르면 0)
//     TRACE_CHUNK=50000          (한 번에 스캔할 블록 수. 노드가 거부하면 자동 축소)
//   시드 지갑은 src/seeds.txt 에 한 줄에 하나씩.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { lookupKnown } from './known-addresses.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC_URL     = process.env.BSC_HTTP_URL || 'https://bsc-rpc.publicnode.com';
const TOKEN       = (process.env.TRACE_TOKEN || '').toLowerCase();
const MAX_DEPTH   = Number(process.env.TRACE_MAX_DEPTH ?? 3);
const MIN_VALUE   = Number(process.env.TRACE_MIN_VALUE ?? 0);
const START_BLOCK = Number(process.env.TRACE_START_BLOCK ?? 0);
let   CHUNK       = Number(process.env.TRACE_CHUNK ?? 50000);

// Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

if (!ethers.isAddress(TOKEN)) { console.error('TRACE_TOKEN 주소가 올바르지 않습니다.'); process.exit(1); }

const provider = new ethers.JsonRpcProvider(RPC_URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const topicAddr = (a) => ethers.zeroPadValue(ethers.getAddress(a), 32);
const fromTopic = (t) => ('0x' + t.slice(26)).toLowerCase();

// --- 주어진 주소들에서 "나간" Transfer 로그를 fromBlock~toBlock 전 구간 스캔 ---
// topic1(=from) 에 주소 배열을 넣어 한 번에 여러 지갑의 outgoing 을 가져옴.
async function scanOutgoing(addresses, fromBlock, toBlock) {
  const fromTopics = addresses.map(topicAddr); // OR 매칭
  const logs = [];
  let start = fromBlock;
  while (start <= toBlock) {
    let end = Math.min(start + CHUNK - 1, toBlock);
    try {
      const got = await provider.getLogs({
        address: TOKEN,
        topics: [TRANSFER_TOPIC, fromTopics],
        fromBlock: start,
        toBlock: end,
      });
      logs.push(...got);
      process.stdout.write(`\r    스캔 ${start}~${end} (누적 로그 ${logs.length})   `);
      start = end + 1;
      await sleep(80);
    } catch (e) {
      const msg = (e.info?.error?.message || e.shortMessage || e.message || '').toLowerCase();
      // 블록 범위/결과수 초과 → 청크 절반으로 줄여 재시도
      if ((msg.includes('limit') || msg.includes('range') || msg.includes('large') ||
           msg.includes('exceed') || msg.includes('-32005') || msg.includes('many')) && CHUNK > 500) {
        CHUNK = Math.max(500, Math.floor(CHUNK / 2));
        process.stdout.write(`\n    · 청크 축소 -> ${CHUNK} 블록 후 재시도\n`);
        continue;
      }
      console.warn(`\n    ! getLogs 실패 ${start}~${end}: ${msg}. 1.5s 후 재시도`);
      await sleep(1500);
    }
  }
  process.stdout.write('\n');
  return logs;
}

const codeCache = new Map();
async function isContract(addr) {
  const a = addr.toLowerCase();
  if (codeCache.has(a)) return codeCache.get(a);
  let result = false;
  try { result = (await provider.getCode(a)) !== '0x'; }
  catch (e) { console.warn(`  ! getCode 실패 ${a}: ${e.message}`); }
  codeCache.set(a, result);
  return result;
}

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)',
                   'function decimals() view returns (uint8)',
                   'function symbol() view returns (string)'];
const token = new ethers.Contract(TOKEN, ERC20_ABI, provider);

async function main() {
  const seedFile = path.join(__dirname, 'seeds.txt');
  if (!fs.existsSync(seedFile)) { console.error(`시드 파일이 없습니다: ${seedFile}`); process.exit(1); }
  const seeds = [...new Set(
    fs.readFileSync(seedFile, 'utf8').split('\n')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => ethers.isAddress(s))
  )];

  const latest = await provider.getBlockNumber();
  console.log(`시드 지갑 ${seeds.length}개, 토큰 ${TOKEN}`);
  console.log(`스캔 범위 블록 ${START_BLOCK} ~ ${latest}, 최대 깊이 ${MAX_DEPTH}, RPC ${RPC_URL}\n`);

  let decimals = 18, symbol = 'TOKEN';
  try { decimals = Number(await token.decimals()); symbol = await token.symbol(); } catch {}
  const toUnit = (raw) => Number(ethers.formatUnits(raw, decimals));

  const edges = [];                 // {from,to,value,hash,depth,toType,toLabel}
  const nodeType = new Map();       // addr -> 'SEED'|'WALLET'|'CEX'|'ROUTER'|'BRIDGE'|'BURN'|'CONTRACT'
  const visited = new Set();        // outgoing 을 이미 스캔한 지갑
  seeds.forEach((s) => nodeType.set(s, 'SEED'));

  let frontier = [...seeds];
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length; depth++) {
    const toScan = frontier.filter((a) => !visited.has(a));
    if (!toScan.length) break;
    toScan.forEach((a) => visited.add(a));
    console.log(`[깊이 ${depth}] 지갑 ${toScan.length}개 outgoing 스캔...`);

    const logs = await scanOutgoing(toScan, START_BLOCK, latest);
    const next = new Set();

    for (const log of logs) {
      const from = fromTopic(log.topics[1]);
      const to   = fromTopic(log.topics[2]);
      const val  = toUnit(BigInt(log.data));
      if (val < MIN_VALUE) continue;

      // 종착지 분류
      let type, label = '';
      const known = lookupKnown(to);
      if (known) { type = known.type; label = known.label; }
      else if (!nodeType.has(to) || nodeType.get(to) === 'WALLET') {
        type = (await isContract(to)) ? 'CONTRACT' : 'WALLET';
      } else type = nodeType.get(to);

      if (!nodeType.has(to) || nodeType.get(to) === 'WALLET') nodeType.set(to, type);
      edges.push({ from, to, value: val, hash: log.transactionHash, depth, toType: type, toLabel: label });

      // 일반 지갑이면 다음 홉으로 (CEX/컨트랙트/소각은 종료)
      if (type === 'WALLET' && depth < MAX_DEPTH && !visited.has(to)) next.add(to);
    }
    frontier = [...next];
  }

  // 현재 잔액 조회 — 발견된 모든 일반 지갑(+시드)
  const wallets = [...nodeType.entries()]
    .filter(([, t]) => t === 'WALLET' || t === 'SEED')
    .map(([a]) => a);
  console.log(`\n잔액 조회 중 (지갑 ${wallets.length}개)...`);
  const holders = [];
  for (const w of wallets) {
    let bal = 0;
    try { bal = toUnit(await token.balanceOf(w)); } catch {}
    if (bal > 0) holders.push({ address: w, balance: bal, type: nodeType.get(w) });
    await sleep(50);
  }
  holders.sort((a, b) => b.balance - a.balance);

  // 출력
  const outDir = path.join(__dirname, '..', 'trace-output');
  fs.mkdirSync(outDir, { recursive: true });

  const csv = ['from,to,value,toType,toLabel,depth,hash',
    ...edges.map((e) => `${e.from},${e.to},${e.value},${e.toType},"${e.toLabel}",${e.depth},${e.hash}`)
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'edges.csv'), csv);
  fs.writeFileSync(path.join(outDir, 'holders.json'), JSON.stringify(holders, null, 2));
  fs.writeFileSync(path.join(outDir, 'nodes.json'),
    JSON.stringify([...nodeType.entries()].map(([a, t]) => ({ address: a, type: t })), null, 2));

  console.log(`\n===== 요약 (${symbol}) =====`);
  console.log(`전송 엣지        : ${edges.length}`);
  console.log(`발견한 노드 총수 : ${nodeType.size}`);
  const byType = {};
  for (const t of nodeType.values()) byType[t] = (byType[t] || 0) + 1;
  console.log('종류별 노드      :', byType);
  console.log(`\n--- 현재 토큰 보유 지갑 (출처=시드, 온체인 잔존) : ${holders.length}곳 ---`);
  for (const h of holders.slice(0, 50)) {
    console.log(`  ${h.address}  ${h.balance.toLocaleString()} ${symbol}  (${h.type})`);
  }
  if (holders.length > 50) console.log(`  ... 외 ${holders.length - 50}곳 (holders.json 참고)`);
  console.log(`\n결과 파일: trace-output/edges.csv, holders.json, nodes.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
