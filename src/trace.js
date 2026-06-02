// 토큰 분배 추적기 (BSC)
// 시드 지갑들에서 시작해 특정 토큰의 Transfer 를 BFS 로 따라가며
// 자금이 흘러간 일반 지갑(EOA) 들을 찾고, 지금도 보유 중인 곳을 표시합니다.
//
// 데이터 소스: 무료 5종을 순서대로 시도(앞이 실패하면 자동 전환). src/providers.js 참고.
//   1) Routescan(무료)  2) RPC publicnode  3) RPC dRPC  4) RPC LlamaRPC  5) RPC dataseed
//   (.env 에 ETHERSCAN_API_KEY 가 있으면 유료 Etherscan 을 0순위로 맨 앞에 추가)
//
// 사용법: .env 에 아래 설정 후  ->  node src/trace.js
//     TRACE_TOKEN=0xF39e4b21c84e737Df08e2C3b32541d856f508E48
//     TRACE_MAX_DEPTH=3          (시드에서 몇 홉까지 따라갈지)
//     TRACE_MIN_VALUE=0          (이 값 미만 전송은 노이즈로 무시, 토큰 단위)
//     TRACE_RPS=5                (scan API 초당 호출 수)
//     TRACE_START_BLOCK=0        (RPC 폴백 사용 시 시작 블록. 알면 넣으면 훨씬 빠름)
//     # ETHERSCAN_API_KEY=...    (선택, 유료 키 있으면 0순위)
//   시드 지갑은 src/seeds.txt 에 한 줄에 하나씩.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { lookupKnown } from './known-addresses.js';
import { buildDefaultPool } from './providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY     = process.env.ETHERSCAN_API_KEY || '';
const TOKEN       = (process.env.TRACE_TOKEN || '').toLowerCase();
const MAX_DEPTH   = Number(process.env.TRACE_MAX_DEPTH ?? 3);
const MIN_VALUE   = Number(process.env.TRACE_MIN_VALUE ?? 0);
const RPS         = Number(process.env.TRACE_RPS ?? 5);
const START_BLOCK = Number(process.env.TRACE_START_BLOCK ?? 0);

if (!ethers.isAddress(TOKEN)) { console.error('TRACE_TOKEN 주소가 올바르지 않습니다.'); process.exit(1); }

const pool = buildDefaultPool({ apiKey: API_KEY, rps: RPS, startBlock: START_BLOCK });

async function main() {
  const seedFile = path.join(__dirname, 'seeds.txt');
  if (!fs.existsSync(seedFile)) { console.error(`시드 파일이 없습니다: ${seedFile}`); process.exit(1); }
  const seeds = [...new Set(
    fs.readFileSync(seedFile, 'utf8').split('\n')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => ethers.isAddress(s))
  )];
  console.log(`시드 지갑 ${seeds.length}개, 토큰 ${TOKEN}, 최대 깊이 ${MAX_DEPTH}`);
  console.log(`데이터 소스 후보: ${pool.providers.map((p) => p.name).join(' → ')}\n`);

  let decimals = 18, symbol = 'TOKEN';
  const meta = await pool.meta(TOKEN);
  decimals = meta.decimals; symbol = meta.symbol;
  const toUnit = (raw) => Number(ethers.formatUnits(raw, decimals));

  const edges = [];                 // {from,to,value,hash,depth,toType,toLabel}
  const nodeType = new Map();       // addr -> 'SEED'|'WALLET'|'CEX'|'ROUTER'|'BRIDGE'|'BURN'|'CONTRACT'
  const visited = new Set();        // outgoing 을 이미 조회한 지갑
  seeds.forEach((s) => nodeType.set(s, 'SEED'));

  let frontier = [...seeds];
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length; depth++) {
    const toScan = frontier.filter((a) => !visited.has(a));
    if (!toScan.length) break;
    const next = new Set();

    for (const addr of toScan) {
      visited.add(addr);
      process.stdout.write(`[d${depth}] ${addr} `);
      const txs = await pool.transfers(TOKEN, addr);
      if (txs.length && symbol === 'TOKEN' && txs[0].tokenDecimal) { // scan 응답이면 메타 보강
        decimals = Number(txs[0].tokenDecimal || 18);
        symbol = txs[0].tokenSymbol || 'TOKEN';
      }
      const outgoing = txs.filter((t) => t.from === addr);
      console.log(`[${pool.active().name}] outgoing ${outgoing.length}건`);

      for (const t of outgoing) {
        const to = t.to;
        const val = toUnit(t.value);
        if (val < MIN_VALUE) continue;

        let type, label = '';
        const known = lookupKnown(to);
        if (known) { type = known.type; label = known.label; }
        else if (!nodeType.has(to) || nodeType.get(to) === 'WALLET') {
          type = (await pool.isContract(to)) ? 'CONTRACT' : 'WALLET';
        } else type = nodeType.get(to);

        if (!nodeType.has(to) || nodeType.get(to) === 'WALLET') nodeType.set(to, type);
        edges.push({ from: addr, to, value: val, hash: t.hash, depth, toType: type, toLabel: label });

        if (type === 'WALLET' && depth < MAX_DEPTH && !visited.has(to)) next.add(to);
      }
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
    const bal = toUnit(await pool.balanceOf(TOKEN, w));
    if (bal > 0) holders.push({ address: w, balance: bal, type: nodeType.get(w) });
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
