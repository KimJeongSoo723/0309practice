// === 2단계: Infinity(v4) 실거래 실행부 (작성 예정) ===
// 1단계 `npm run quote:v4` 의 실제 출력으로 Smart Router/Universal Router 의
// calldata 빌드 방식을 확정한 뒤 여기에 매도 실행 루프를 구현합니다.
//
// 계획:
//  - quoteV4.js 와 동일하게 best trade 산정 (시작 잔액 100분할 청크)
//  - SmartRouter.SwapRouter.swapCallParameters(trade, { recipient, slippageTolerance })
//    로 calldata/value 생성
//  - viem walletClient.sendTransaction 으로 Universal/Smart Router 에 전송
//  - 회차마다 무작위 대기, 마지막/잔량 회차 전량 매도
//
// 지금은 먼저 견적을 돌려 SDK API 형태를 확정해주세요.

console.log("아직 미구현입니다. 먼저 `npm run quote:v4` 를 실행해 견적 출력을 공유해주세요.");
console.log("그 결과로 실행부를 확정합니다.");
process.exit(0);
