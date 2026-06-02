// 데이터 소스 어댑터 + 폴백 풀
// 두 종류의 provider 를 동일한 인터페이스로 제공:
//   - scan : Etherscan 호환 REST API (tokentx 로 전체 이력 한 번에)  ← Etherscan/Routescan
//   - rpc  : 공개 JSON-RPC 노드 (eth_getLogs 로 Transfer 직접 스캔)
//
// 공통 메서드(모두 async):
//   transfers(token, address) -> [{from,to,value(raw문자열),hash, tokenDecimal?, tokenSymbol?}]
//   isContract(address)       -> boolean
//   balanceOf(token, address) -> bigint
//   meta(token)               -> { decimals, symbol }
//
// Pool 은 provider 들을 순서대로 보관하고, transfers() 가 실패하면
// 다음 provider 로 영구 전환(sticky)한다. (rate limit 은 각 provider 내부에서 재시도)

import { ethers } from 'ethers';

const CHAIN_ID = 56;
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ERC20_IFACE = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const padAddr = (a) => ethers.zeroPadValue(ethers.getAddress(a), 32);
const topicToAddr = (t) => ('0x' + t.slice(26)).toLowerCase();

// ───────────────────────── scan (Etherscan 호환) ─────────────────────────
export function scanProvider({ name, baseUrl, apiKey = '', gapMs = 250 }) {
  async function call(params) {
    const q = { ...params, chainid: String(CHAIN_ID) };
    if (apiKey) q.apikey = apiKey;
    const url = `${baseUrl}?${new URLSearchParams(q)}`;
    for (let attempt = 1; ; attempt++) {
      let json;
      try {
        const res = await fetch(url);
        json = await res.json();
      } catch (e) {
        if (attempt <= 4) { await sleep(800 * attempt); continue; }
        throw new Error(`fetch 실패: ${e.message}`);
      }
      await sleep(gapMs);
      const resultStr = typeof json.result === 'string' ? json.result : '';
      const low = `${json.message || ''} ${resultStr}`.toLowerCase();
      if ((low.includes('rate limit') || low.includes('max calls') || low.includes('too many')) && attempt <= 6) {
        await sleep(1000 * attempt); continue;
      }
      if (low.includes('not supported for this chain') || low.includes('invalid api key')) {
        throw new Error(`사용 불가: ${resultStr || json.message}`); // → 풀이 다음 provider 로 전환
      }
      return json;
    }
  }

  return {
    name, kind: 'scan',
    async transfers(token, address) {
      const out = [];
      let startblock = 0;
      const offset = 10000;
      for (;;) {
        const json = await call({
          module: 'account', action: 'tokentx',
          contractaddress: token, address,
          startblock: String(startblock), endblock: '999999999',
          page: '1', offset: String(offset), sort: 'asc',
        });
        if (json.status === '0' && /no transactions found/i.test(json.message || '')) break;
        if (!Array.isArray(json.result)) {
          throw new Error(`tokentx 형식 이상: status=${json.status} message=${JSON.stringify(json.message)} result=${JSON.stringify(json.result)}`);
        }
        out.push(...json.result.map((t) => ({
          from: t.from.toLowerCase(), to: t.to.toLowerCase(),
          value: t.value, hash: t.hash,
          tokenDecimal: t.tokenDecimal, tokenSymbol: t.tokenSymbol,
        })));
        if (json.result.length < offset) break;
        const last = Number(json.result[json.result.length - 1].blockNumber);
        if (last === startblock) break;
        startblock = last;
      }
      return out;
    },
    async isContract(addr) {
      const json = await call({ module: 'proxy', action: 'eth_getCode', address: addr, tag: 'latest' });
      return typeof json.result === 'string' && json.result !== '0x' && json.result !== '0x0';
    },
    async balanceOf(token, addr) {
      const json = await call({ module: 'account', action: 'tokenbalance', contractaddress: token, address: addr, tag: 'latest' });
      return typeof json.result === 'string' && /^\d+$/.test(json.result) ? BigInt(json.result) : 0n;
    },
    async meta(token) {
      let decimals = 18, symbol = 'TOKEN';
      try {
        const d = await call({ module: 'proxy', action: 'eth_call', to: token, data: '0x313ce567', tag: 'latest' });
        if (d.result && d.result !== '0x') decimals = Number(BigInt(d.result));
        const s = await call({ module: 'proxy', action: 'eth_call', to: token, data: '0x95d89b41', tag: 'latest' });
        if (s.result && s.result !== '0x') symbol = ERC20_IFACE.decodeFunctionResult('symbol', s.result)[0];
      } catch { /* 기본값 사용 */ }
      return { decimals, symbol };
    },
  };
}

// ───────────────────────── rpc (eth_getLogs) ─────────────────────────
export function rpcProvider({ name, url, startBlock = 0, chunk = 10000 }) {
  const provider = new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true });
  let CHUNK = chunk;

  return {
    name, kind: 'rpc',
    async transfers(token, address) {
      const latest = await provider.getBlockNumber(); // 실패하면 throw → 풀 전환
      const fromTopic = padAddr(address);
      const out = [];
      let start = startBlock;
      let fails = 0;
      while (start <= latest) {
        const end = Math.min(start + CHUNK - 1, latest);
        try {
          const logs = await provider.getLogs({
            address: token, topics: [TRANSFER_TOPIC, fromTopic], fromBlock: start, toBlock: end,
          });
          for (const lg of logs) {
            out.push({
              from: topicToAddr(lg.topics[1]), to: topicToAddr(lg.topics[2]),
              value: BigInt(lg.data).toString(), hash: lg.transactionHash,
            });
          }
          start = end + 1; fails = 0;
          await sleep(70);
        } catch (e) {
          const msg = (e.info?.error?.message || e.error?.message || e.shortMessage || e.message || '').toLowerCase();
          if (CHUNK > 1000) { CHUNK = Math.max(1000, Math.floor(CHUNK / 2)); continue; }
          if (++fails > 5) throw new Error(`getLogs 반복 실패: ${msg}`); // → 풀 전환
          await sleep(1500);
        }
      }
      return out;
    },
    async isContract(addr) {
      return (await provider.getCode(addr)) !== '0x';
    },
    async balanceOf(token, addr) {
      const data = ERC20_IFACE.encodeFunctionData('balanceOf', [addr]);
      const res = await provider.call({ to: token, data });
      return res && res !== '0x' ? BigInt(res) : 0n;
    },
    async meta(token) {
      let decimals = 18, symbol = 'TOKEN';
      try {
        const c = new ethers.Contract(token, ERC20_IFACE, provider);
        decimals = Number(await c.decimals());
        symbol = await c.symbol();
      } catch { /* 기본값 */ }
      return { decimals, symbol };
    },
  };
}

// ───────────────────────── 폴백 풀 ─────────────────────────
export class Pool {
  constructor(providers) { this.providers = providers; this.i = 0; }
  active() { return this.providers[this.i]; }

  // transfers 는 핵심 기능 → 실패 시 다음 provider 로 영구 전환
  async transfers(token, address) {
    while (this.i < this.providers.length) {
      const p = this.providers[this.i];
      try { return await p.transfers(token, address); }
      catch (e) {
        console.warn(`\n  [${p.name}] 전송조회 실패: ${e.message}\n  → 다음 소스로 전환`);
        this.i++;
      }
    }
    throw new Error('모든 데이터 소스 실패 (transfers)');
  }

  // 보조 기능들은 현재 active provider 로 best-effort (실패해도 소스 전환 안 함)
  async isContract(addr) {
    try { return await this.active().isContract(addr); } catch { return false; }
  }
  async balanceOf(token, addr) {
    try { return await this.active().balanceOf(token, addr); } catch { return 0n; }
  }
  async meta(token) {
    try { return await this.active().meta(token); } catch { return { decimals: 18, symbol: 'TOKEN' }; }
  }
}

// 풀 구성.
//   - 유료 Etherscan 키가 있으면 → Etherscan 단독 사용(다른 소스로 폴백하지 않음).
//   - 키가 없으면 → 무료 5종을 순서대로 폴백.
export function buildDefaultPool({ apiKey = '', rps = 5, startBlock = 0 } = {}) {
  const gapMs = Math.ceil(1000 / Math.max(1, rps)) + 20;
  if (apiKey) {
    // 유료 단독 모드
    return new Pool([
      scanProvider({ name: 'Etherscan(유료,단독)', baseUrl: 'https://api.etherscan.io/v2/api', apiKey, gapMs }),
    ]);
  }
  // 무료 폴백 모드
  return new Pool([
    scanProvider({ name: 'Routescan(무료)', baseUrl: 'https://api.routescan.io/v2/network/mainnet/evm/56/etherscan/api', gapMs }),
    rpcProvider({ name: 'RPC publicnode', url: 'https://bsc-rpc.publicnode.com', startBlock }),
    rpcProvider({ name: 'RPC dRPC',       url: 'https://bsc.drpc.org', startBlock }),
    rpcProvider({ name: 'RPC LlamaRPC',   url: 'https://binance.llamarpc.com', startBlock }),
    rpcProvider({ name: 'RPC dataseed',   url: 'https://bsc-dataseed1.bnbchain.org', startBlock }),
  ]);
}
