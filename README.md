# PancakeSwap V2 Sniping Bot

PancakeSwap V2 풀이 생성되는 순간 지정 토큰을 매수하는 봇.
라우터의 `amountOutMin` 으로 **온체인 가격 상한**을 강제합니다.

## 동작 방식

1. WebSocket 으로 PancakeSwap V2 Factory의 `PairCreated` 이벤트를 구독
2. 새 풀의 두 토큰이 `(WBNB, TARGET_TOKEN)` 조합인지 확인
3. 맞으면 `swapExactETHForTokens` 호출 — `amountOutMin = amountIn / maxPrice`
4. 풀 가격이 한도(`MAX_PRICE_BNB_PER_TOKEN`)보다 비싸면 `INSUFFICIENT_OUTPUT_AMOUNT` 로 자동 revert

## 사전 준비

- Node.js 20 이상
- BSC 지갑 + 약간의 BNB (가스용)
- BSC RPC 의 **WSS 엔드포인트** (속도가 핵심이라 유료 권장)

## 로컬 실행 절차

```bash
# 1) 의존성 설치
npm install

# 2) 환경 변수 설정
cp .env.example .env
# .env 파일 열어서 PRIVATE_KEY, TARGET_TOKEN, AMOUNT_IN_BNB 등 채우기

# 3) 설정/잔액 확인
npm run check

# 4) DRY RUN (실제 매수 X — 시뮬레이션만)
#    .env 의 DRY_RUN=true 인 상태로 실행
npm run snipe

# 5) 실거래
#    .env 의 DRY_RUN=false 로 변경 후
npm run snipe
```

## .env 주요 항목

| 키 | 설명 |
|---|---|
| `NETWORK` | `mainnet` 또는 `testnet` |
| `BSC_WSS_URL` | WebSocket RPC. 속도 = 승률 |
| `PRIVATE_KEY` | 매수 지갑 키 (절대 커밋 금지) |
| `TARGET_TOKEN` | 매수할 토큰 컨트랙트 주소 |
| `TARGET_TOKEN_DECIMALS` | 토큰 decimals (기본 18) |
| `AMOUNT_IN_BNB` | 1회 매수에 쓸 BNB |
| `MAX_PRICE_BNB_PER_TOKEN` | **가격 상한 (BNB per 1 token)**. 예: `0.007` |
| `GAS_PRICE_GWEI` | 가스 가격 (경쟁 클수록 ↑) |
| `DRY_RUN` | `true` 면 트랜잭션 안 보내고 결과만 확인 |

## 가격 상한 = 0.007 이 어떻게 강제되는지

```js
// src/config.js
amountOutMin = amountInWei * 10^decimals / maxPriceWei
```

- `AMOUNT_IN_BNB=0.05`, `MAX_PRICE_BNB_PER_TOKEN=0.007` 이면
  최소 받아야 할 토큰 = `0.05 / 0.007 ≈ 7.142857` 토큰
- 풀 가격이 0.007 BNB/token 을 초과하면 실제 받는 토큰이 이 값보다 적어지므로 PancakeSwap Router 가 `INSUFFICIENT_OUTPUT_AMOUNT` 로 revert
- 즉, **가스비만 잃고 비싸게 매수되는 일은 없음**

## 테스트넷에서 먼저 돌려보기

```env
NETWORK=testnet
BSC_WSS_URL=wss://bsc-testnet-rpc.publicnode.com
BSC_HTTP_URL=https://data-seed-prebsc-1-s1.binance.org:8545
```

테스트넷 BNB 는 https://testnet.binance.org/faucet-smart 에서 받을 수 있습니다.

## 주의

- 개인키는 평문이라 `.env` 는 절대 커밋하지 마세요 (`.gitignore` 에 포함됨)
- 공개 RPC 로는 봇 경쟁에서 거의 못 이깁니다. 실전은 유료 노드 / private mempool 필요
- 이 코드는 **fee-on-transfer 토큰을 지원하지 않습니다** (ABI 는 들어있으니 호출만 바꾸면 됨)
