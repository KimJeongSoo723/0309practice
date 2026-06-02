// 토큰 분배 추적기 (BSC)
// 시드 지갑들에서 시작해 특정 토큰의 Transfer 를 BFS 로 따라가며
// 자금이 흘러간 일반 지갑(EOA) 들을 찾고, 지금도 보유 중인 곳을 표시합니다.
//
// 데이터 소스:
//   - 전송 이력 : Etherscan V2 통합 API (chainid=56, BscScan), 무료 키
//   - 컨트랙트 판별 / 현재 잔액 : BSC RPC (HTTP)
//
// 사용법:
//   .env 에 아래 설정 후  ->  node src/trace.js
//     ETHERSCAN_API_KEY=...        (https://etherscan.io/myapikey 무료)
//     BSC_HTTP_URL=https://bsc-dataseed.binance.org
//     TRACE_TOKEN=0xF39e4b21c84e737Df08e2C3b32541d856f508E48
//     TRACE_MAX_DEPTH=3            (시드에서 몇 홉까지 따라갈지)
//     TRACE_MIN_VALUE=0           (이 값 미만 전송은 노이즈로 무시, 토큰 단위)
//   시드 지갑은 src/seeds.txt 에 한 줄에 하나씩.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { lookupKnown } from './known-addresses.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY   = process.env.ETHERSCAN_API_KEY;
const RPC_URL   = process.env.BSC_HTTP_URL || 'https://bsc-dataseed.binance.org';
const TOKEN     = (process.env.TRACE_TOKEN || '').toLowerCase();
const MAX_DEPTH = Number(process.env.TRACE_MAX_DEPTH ?? 3);
const MIN_VALUE = Number(process.env.TRACE_MIN_VALUE ?? 0);
const API_BASE  = 'https://api.etherscan.io/v2/api';
const CHAIN_ID  = 56;

if (!API_KEY) { console.error('ETHERSCAN_API_KEY 가 필요합니다 (.env).'); process.exit(1); }
if (!ethers.isAddress(TOKEN)) { console.error('TRACE_TOKEN 주소가 올바르지 않습니다.'); process.exit(1); }

const provider = new ethers.JsonRpcProvider(RPC_URL);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Etherscan V2: 특정 주소의 특정 토큰 전송 이력 전부 가져오기 (블록 윈도잉) ---
async function fetchTokenTx(address) {
  const out = [];
  let startblock = 0;
  const offset = 10000;
  for (;;) {
    const url = `${API_BASE}?chainid=${CHAIN_ID}&module=account&action=tokentx`
      + `&contractaddress=${TOKEN}&address=${address}`
      + `&startblock=${startblock}&endblock=999999999&page=1&offset=${offset}&sort=asc&apikey=${API_KEY}`;
    const res = await fetch(url);
    const json = await res.json();
    await sleep(220); // 무료 키 rate limit (≈5 req/s) 여유
    if (json.status === '0' && json.message === 'No transactions found') break;
    if (!Array.isArray(json.result)) {
      console.warn(`  ! API 응답 이상 (${address}):`, json.message || json.result);
      break;
    }
    out.push(...json.result);
    if (json.result.length < offset) break;
    // 다음 윈도우: 마지막 블록부터 (중복은 뒤에서 dedupe)
    const lastBlock = Number(json.result[json.result.length - 1].blockNumber);
    if (lastBlock === startblock) break;
    startblock = lastBlock;
  }
  // tx 해시+logindex 로 dedupe
  const seen = new Set();
  return out.filter((t) => {
    const k = `${t.hash}:${t.from}:${t.to}:${t.value}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
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
  console.log(`시드 지갑 ${seeds.length}개, 토큰 ${TOKEN}, 최대 깊이 ${MAX_DEPTH}\n`);

  let decimals = 18, symbol = 'TOKEN';
  try { decimals = Number(await token.decimals()); symbol = await token.symbol(); } catch {}
  const toUnit = (raw) => Number(ethers.formatUnits(raw, decimals));

  const edges = [];                 // {from,to,value,hash,depth,toType,toLabel}
  const nodeType = new Map();       // addr -> 'SEED'|'WALLET'|'CEX'|'ROUTER'|'BRIDGE'|'BURN'|'CONTRACT'
  const visited = new Set();        // outgoing 을 이미 조회한 지갑
  seeds.forEach((s) => nodeType.set(s, 'SEED'));

  // BFS
  let frontier = seeds.map((a) => ({ addr: a, depth: 0 }));
  while (frontier.length) {
    const next = [];
    for (const { addr, depth } of frontier) {
      if (visited.has(addr)) continue;
      visited.add(addr);
      process.stdout.write(`[d${depth}] ${addr} ... `);
      const txs = await fetchTokenTx(addr);
      const outgoing = txs.filter((t) => t.from.toLowerCase() === addr);
      console.log(`outgoing ${outgoing.length}건`);

      for (const t of outgoing) {
        const to = t.to.toLowerCase();
        const val = toUnit(t.value);
        if (val < MIN_VALUE) continue;

        // 종착지 분류
        let type, label = '';
        const known = lookupKnown(to);
        if (known) { type = known.type; label = known.label; }
        else if (!nodeType.has(to) || nodeType.get(to) === 'WALLET') {
          type = (await isContract(to)) ? 'CONTRACT' : 'WALLET';
        } else type = nodeType.get(to);

        if (!nodeType.has(to) || nodeType.get(to) === 'WALLET') nodeType.set(to, type);
        edges.push({ from: addr, to, value: val, hash: t.hash, depth, toType: type, toLabel: label });

        // 일반 지갑이면 다음 홉으로 (CEX/컨트랙트/소각은 종료)
        if (type === 'WALLET' && depth < MAX_DEPTH && !visited.has(to)) {
          next.push({ addr: to, depth: depth + 1 });
        }
      }
    }
    frontier = next;
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
    await sleep(60);
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
  console.log(`전송 엣지       : ${edges.length}`);
  console.log(`발견한 노드 총수 : ${nodeType.size}`);
  const byType = {};
  for (const t of nodeType.values()) byType[t] = (byType[t] || 0) + 1;
  console.log('종류별 노드     :', byType);
  console.log(`\n--- 현재 토큰 보유 지갑 (출처=시드, 온체인 잔존) : ${holders.length}곳 ---`);
  for (const h of holders.slice(0, 50)) {
    console.log(`  ${h.address}  ${h.balance.toLocaleString()} ${symbol}  (${h.type})`);
  }
  if (holders.length > 50) console.log(`  ... 외 ${holders.length - 50}곳 (holders.json 참고)`);
  console.log(`\n결과 파일: trace-output/edges.csv, holders.json, nodes.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
