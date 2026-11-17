import { parseAbi } from "viem";

export const engineAbi = parseAbi([
  "function trade(uint256 pid, uint256 bid, uint256 m, int256 size, int256 limitPrice)",
  "function queueCross(uint256 pid, uint256 bid, uint256 m, int256 size, uint16 maxSlipBps)",
  "function settleWindow(uint256 m, uint64 w)",
  "function enforce(uint256 pid, uint256 bid)",
  "function crystallize(uint256 pid, uint256 bid)",
  "function flatten(uint256 pid)",
  "function quote(uint256 m, int256 size) view returns (int256 mark, int256 lensPrice)",
  "function crystalRisk(uint256 pid) view returns (int256 equity, int256 im, int256 mm)",
  "function grossMargin(uint256 pid) view returns (int256)",
  "function beamEquity(uint256 pid, uint256 bid) view returns (int256)",
  "event Filled(uint256 indexed crystal, uint256 indexed beam, uint256 indexed market, int256 size, int256 price, int256 fee, bool crossed)",
  "event WindowSettled(uint256 indexed market, uint64 indexed window, int256 matched, int256 residual, bool residualFilled, int256 mark)",
]);
