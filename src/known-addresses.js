// 알려진 주소 라벨 (모두 소문자로 비교).
// CEX 핫월렛 / 입금 집결 주소는 여기 들어가면 추적을 멈춥니다.
// 목록은 완전하지 않습니다 — 추적 중 의심스러운 종착지가 나오면
// BscScan 의 주소 라벨을 보고 여기에 계속 추가하세요.

// type 종류:
//   'CEX'      - 거래소 핫월렛/입금 (추적 종료, 내부는 불가)
//   'ROUTER'   - DEX 라우터 (스왑 → 보유 추적 종료점)
//   'BRIDGE'   - 크로스체인 브리지
//   'BURN'     - 소각 주소
export const KNOWN = {
  // --- 소각 ---
  '0x000000000000000000000000000000000000dead': { type: 'BURN', label: 'Burn (dead)' },
  '0x0000000000000000000000000000000000000000': { type: 'BURN', label: 'Zero address' },

  // --- DEX 라우터 (대표적인 것들) ---
  '0x10ed43c718714eb63d5aa57b78b54704e256024e': { type: 'ROUTER', label: 'PancakeSwap V2 Router' },
  '0x13f4ea83d0bd40e75c8222255bc855a974568dd4': { type: 'ROUTER', label: 'PancakeSwap V3 Router' },
  '0x1b81d678ffb9c0263b24a97847620c99d213eb14': { type: 'ROUTER', label: 'PancakeSwap SmartRouter' },

  // --- Binance 핫월렛 (BSC, 대표 일부) ---
  '0x8894e0a0c962cb723c1976a4421c95949be2d4e3': { type: 'CEX', label: 'Binance Hot Wallet' },
  '0xe2fc31f816a9b94326492132018c3aecc4a93ae1': { type: 'CEX', label: 'Binance Hot Wallet 2' },
  '0xf977814e90da44bfa03b6295a0616a897441acec': { type: 'CEX', label: 'Binance 8' },
  '0x3c783c21a0383057d128bae431894a5c19f9cf06': { type: 'CEX', label: 'Binance Hot Wallet' },
  '0x161ba15a5f335c9f06bb5bbb0a9ce14076fbb645': { type: 'CEX', label: 'Binance' },

  // --- 기타 거래소 (예시 — 실제 추적 시 라벨 확인 후 보강) ---
  '0x0d0707963952f2fba59dd06f2b425ace40b492fe': { type: 'CEX', label: 'Gate.io' },
};

export function lookupKnown(addr) {
  return KNOWN[addr.toLowerCase()] || null;
}
