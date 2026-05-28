export const FACTORY_ABI = [
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)"
];

export const ROUTER_ABI = [
  "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external payable returns (uint256[] memory amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external payable"
];
