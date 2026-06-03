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

---

# 매도(SELL) 봇 — `npm run sell`

보유한 토큰을 PancakeSwap V2 에서 **시작 잔액을 100등분해 네이티브 BNB 로 반복 매도**하는 전략.
한 번에 다 팔 때 생기는 가격 충격을 피하려고 소액으로 쪼개 매도합니다.
(경로: `TOKEN → WBNB`, `swapExactTokensForETH`)

## 동작 방식

1. 시작 시 보유 잔액을 `SPLIT_COUNT`(기본 100) 등분 → 1회 매도량 고정
2. 매 회차 그 청크만큼 매도. `getAmountsOut` 으로 실수령 BNB 추정 →
   `SLIPPAGE_BPS` 만큼 뺀 값을 `amountOutMin` 으로 강제
   (`getAmountsOut` 이 실패하면 `amountOutMin=0` 으로 폴백하고 경고)
3. `swapExactTokensForETHSupportingFeeOnTransferTokens` 호출 (전송세 토큰 대응, 네이티브 BNB 수령)
4. `INTERVAL_MIN_SECONDS ~ INTERVAL_MAX_SECONDS` 무작위 대기 후 반복
5. 마지막 회차나 잔량이 청크보다 작아지면 전량 매도 후 종료

> `getAmountsIn` 을 쓰지 않으므로, 풀 유동성이 얕아 큰 단위 견적이 실패하던 문제를 피합니다.

> 첫 실행 시 라우터에 매도 권한(`approve`)을 한 번 부여합니다 (DRY_RUN 이면 생략).

## 실행 절차

```bash
npm install
cp .env.example .env
# .env 에 PRIVATE_KEY, BSC_HTTP_URL, TOKEN_TO_SELL 채우기
# (TOKEN_TO_SELL 기본값은 0x4d41A5d412f4Ef44A35b9f53b06DB65edE249493)

# DRY_RUN=true 상태(기본)로 먼저 시뮬레이션 — 잔액/경로/예상 수령액 확인
npm run sell

# 문제 없으면 .env 의 DRY_RUN=false 로 바꾸고 실거래
npm run sell
```

`Ctrl+C` 를 누르면 진행 중인 매도를 마친 뒤 안전하게 종료합니다.

## 매도 봇 .env 항목

| 키 | 설명 |
|---|---|
| `BSC_HTTP_URL` | HTTP RPC 엔드포인트 (매도엔 WSS 불필요) |
| `TOKEN_TO_SELL` | 매도할 토큰 컨트랙트 주소 |
| `SPLIT_COUNT` | 시작 잔액을 몇 등분해 팔지. 기본 100 |
| `SLIPPAGE_BPS` | 슬리피지 허용치(bps). 200 = 2% |
| `FEE_ON_TRANSFER` | 전송세 토큰이면 `true` (모르면 `true`) |
| `INTERVAL_MIN_SECONDS` / `INTERVAL_MAX_SECONDS` | 매도 간격(초) 무작위 범위 |
| `DRY_RUN` | `true` 면 시뮬레이션만 (기본 `true`) |

## 주의

- 받는 대금은 **네이티브 BNB** 입니다 (`TOKEN/WBNB` 풀 사용). 해당 풀에 유동성이 없으면 DRY_RUN 에서 경로 오류가 납니다.
- 직접 보유한 토큰을 본인 지갑에서 매도하는 용도입니다. 시세조종(워시 트레이딩 등) 목적으로 쓰지 마세요.
