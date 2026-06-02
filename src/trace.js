// 토큰 분배 추적기 (BSC) — Etherscan 호환 API
// 시드 지갑들에서 시작해 특정 토큰의 Transfer 를 BFS 로 따라가며
// 자금이 흘러간 일반 지갑(EOA) 들을 찾고, 지금도 보유 중인 곳을 표시합니다.
//
// 데이터 소스(기본): Routescan — Etherscan 과 동일한 응답 형식을 BSC 에 대해
//   무료·키 없이 제공합니다. 전송이력/컨트랙트판별/현재잔액 모두 처리 — RPC 불필요.
//   (Etherscan 유료 키를 쓰려면 .env 에 TRACE_API_BASE 와 ETHERSCAN_API_KEY 지정)
//
// 사용법: .env 에 아래 설정 후  ->  node src/trace.js
//     TRACE_TOKEN=0xF39e4b21c84e737Df08e2C3b32541d856f508E48
//     TRACE_MAX_DEPTH=3          (시드에서 몇 홉까지 따라갈지)
//     TRACE_MIN_VALUE=0          (이 값 미만 전송은 노이즈로 무시, 토큰 단위)
//     TRACE_RPS=4                (초당 API 호출 수. 무료는 낮게. 기본 4)
//     # (선택) Etherscan 유료로 바꾸려면:
//     # TRACE_API_BASE=https://api.etherscan.io/v2/api
//     # ETHERSCAN_API_KEY=유료키
//   시드 지갑은 src/seeds.txt 에 한 줄에 하나씩.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { lookupKnown } from './known-addresses.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY   = process.env.ETHERSCAN_API_KEY || '';
const TOKEN     = (process.env.TRACE_TOKEN || '').toLowerCase();
const MAX_DEPTH = Number(process.env.TRACE_MAX_DEPTH ?? 3);
const MIN_VALUE = Number(process.env.TRACE_MIN_VALUE ?? 0);
const RPS       = Number(process.env.TRACE_RPS ?? 4);
// 기본: Routescan 의 Etherscan 호환 무료 엔드포인트 (BSC = chain 56)
const API_BASE  = process.env.TRACE_API_BASE || 'https://api.routescan.io/v2/network/mainnet/evm/56/etherscan/api';
const CHAIN_ID  = 56;
const GAP_MS    = Math.ceil(1000 / Math.max(1, RPS)) + 20; // 호출 간 최소 간격

if (!ethers.isAddress(TOKEN)) { console.error('TRACE_TOKEN 주소가 올바르지 않습니다.'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Etherscan 호환 호출 (rate limit 자동 재시도 + 에러 그대로 노출) ---
async function api(params) {
  const base = { module: '', action: '', ...params, chainid: String(CHAIN_ID) };
  if (API_KEY) base.apikey = API_KEY;       // 키 있으면 첨부(없어도 Routescan 동작)
  const url = `${API_BASE}?${new URLSearchParams(base)}`;
  for (let attempt = 1; ; attempt++) {
    let json;
    try {
      const res = await fetch(url);
      json = await res.json();
    } catch (e) {
      if (attempt <= 5) { await sleep(1000 * attempt); continue; }
      throw e;
    }
    await sleep(GAP_MS);
    const resultStr = typeof json.result === 'string' ? json.result : '';
    const low = `${json.message || ''} ${resultStr}`.toLowerCase();
    if ((low.includes('rate limit') || low.includes('max calls') || low.includes('too many')) && attempt <= 6) {
      await sleep(1000 * attempt);
      continue;
    }
    // 무료 미지원 등 치명적 오류는 즉시 알림
    if (low.includes('not supported for this chain')) {
      console.error(`\n[치명] ${resultStr}\n→ 이 엔드포인트/키는 BSC 미지원입니다. TRACE_API_BASE 를 확인하세요.`);
      process.exit(1);
    }
    return json;
  }
}

// 특정 주소의 특정 토큰 전송 이력 전부 (블록 윈도잉 페이지네이션)
async function fetchTokenTx(address) {
  const out = [];
  let startblock = 0;
  const offset = 10000;
  for (;;) {
    const json = await api({
      module: 'account', action: 'tokentx',
      contractaddress: TOKEN, address,
      startblock: String(startblock), endblock: '999999999',
      page: '1', offset: String(offset), sort: 'asc',
    });
    if (json.status === '0' && json.message === 'No transactions found') break;
    if (!Array.isArray(json.result)) {
      console.warn(`  ! 응답 이상 (${address}): status=${json.status} message=${JSON.stringify(json.message)} result=${JSON.stringify(json.result)}`);
      break;
    }
    out.push(...json.result);
    if (json.result.length < offset) break;
    const lastBlock = Number(json.result[json.result.length - 1].blockNumber);
    if (lastBlock === startblock) break; // 같은 블록에 10000건 이상이면 무한루프 방지
    startblock = lastBlock;
  }
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
  const json = await api({ module: 'proxy', action: 'eth_getCode', address: a, tag: 'latest' });
  const result = typeof json.result === 'string' && json.result !== '0x' && json.result !== '0x0';
  codeCache.set(a, result);
  return result;
}

async function balanceOf(addr) {
  const json = await api({ module: 'account', action: 'tokenbalance', contractaddress: TOKEN, address: addr, tag: 'latest' });
  return typeof json.result === 'string' && /^\d+$/.test(json.result) ? BigInt(json.result) : 0n;
}

async function main() {
  const seedFile = path.join(__dirname, 'seeds.txt');
  if (!fs.existsSync(seedFile)) { console.error(`시드 파일이 없습니다: ${seedFile}`); process.exit(1); }
  const seeds = [...new Set(
    fs.readFileSync(seedFile, 'utf8').split('\n')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => ethers.isAddress(s))
  )];
  console.log(`시드 지갑 ${seeds.length}개, 토큰 ${TOKEN}, 최대 깊이 ${MAX_DEPTH}, ${RPS} req/s`);
  console.log(`데이터 소스: ${API_BASE}${API_KEY ? ' (키 사용)' : ' (키 없음/무료)'}\n`);

  let decimals = 18, symbol = 'TOKEN';
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
      process.stdout.write(`[d${depth}] ${addr} ... `);
      const txs = await fetchTokenTx(addr);
      if (txs.length && symbol === 'TOKEN') { // 토큰 메타데이터 한 번만 확보
        decimals = Number(txs[0].tokenDecimal || 18);
        symbol = txs[0].tokenSymbol || 'TOKEN';
      }
      const outgoing = txs.filter((t) => t.from.toLowerCase() === addr);
      console.log(`outgoing ${outgoing.length}건`);

      for (const t of outgoing) {
        const to = t.to.toLowerCase();
        const val = toUnit(t.value);
        if (val < MIN_VALUE) continue;

        let type, label = '';
        const known = lookupKnown(to);
        if (known) { type = known.type; label = known.label; }
        else if (!nodeType.has(to) || nodeType.get(to) === 'WALLET') {
          type = (await isContract(to)) ? 'CONTRACT' : 'WALLET';
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
    const bal = toUnit(await balanceOf(w));
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
