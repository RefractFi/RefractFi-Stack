import { abs, fee, fillPrice, type MarketParams } from "./math.js";

export interface CrossOrder {
  id: string;
  size: bigint; // WAD, signed
  maxSlipBps: number;
}

export interface CrossFill {
  id: string;
  crossed: bigint;
  crossedFee: bigint;
  residual: bigint;
  residualPrice: bigint;
  residualFee: bigint;
}

export interface CrossResult {
  mark: bigint;
  matched: bigint;
  residual: bigint;
  residualFilled: boolean;
  lensPrice: bigint;
  skewAfter: bigint;
  fills: CrossFill[];
}

/** Exact mirror of RefractEngine.settleWindow for orders that are still valid at settlement. */
export function settleWindow(orders: CrossOrder[], mark: bigint, skew: bigint, mp: MarketParams): CrossResult {
  let buys = 0n;
  let sells = 0n;
  for (const o of orders) {
    if (o.size > 0n) buys += o.size;
    else sells -= o.size;
  }
  const buyHeavy = buys > sells;
  const matched = buys < sells ? buys : sells;
  const larger = buyHeavy ? buys : sells;
  const residual = buys - sells;
  let lensPrice = mark;
  let residualOk = false;
  let lastLarge = -1;
  if (residual !== 0n) {
    lensPrice = fillPrice(mark, skew, residual, mp.skewScale);
    const newSkew = skew + residual;
    residualOk = !(abs(newSkew) > mp.maxSkew && abs(newSkew) > abs(skew));
    for (let i = 0; i < orders.length && residualOk; i++) {
      if (orders[i].size > 0n !== buyHeavy) continue;
      if (abs(lensPrice - mark) * 10_000n > BigInt(orders[i].maxSlipBps) * mark) residualOk = false;
      lastLarge = i;
    }
    if (!residualOk) orders.forEach((o, i) => (o.size > 0n === buyHeavy ? (lastLarge = i) : 0));
  }
  let crossedSoFar = 0n;
  let skewAfter = skew;
  const fills: CrossFill[] = orders.map((o, i) => {
    let crossed = 0n;
    let res = 0n;
    const heavy = residual !== 0n && o.size > 0n === buyHeavy;
    if (!heavy) crossed = o.size;
    else {
      if (i === lastLarge) crossed = (o.size > 0n ? matched : -matched) - crossedSoFar;
      else {
        crossed = (o.size * matched) / larger;
        crossedSoFar += crossed;
      }
      if (residualOk) res = o.size - crossed;
    }
    skewAfter += crossed + res;
    return {
      id: o.id,
      crossed,
      crossedFee: fee(crossed, mark, mp.crossFeeBps),
      residual: res,
      residualPrice: lensPrice,
      residualFee: fee(res, lensPrice, mp.takerFeeBps),
    };
  });
  return { mark, matched, residual, residualFilled: residualOk, lensPrice, skewAfter, fills };
}

/** What a crossing order is expected to cost vs trading immediately against the Lens (for agents choosing a route). */
export function routeQuote(size: bigint, mark: bigint, skew: bigint, oppositeFlow: bigint, mp: MarketParams) {
  const lens = fillPrice(mark, skew, size, mp.skewScale);
  const immediateCost = abs(((lens - mark) * size) / 10n ** 18n) + fee(size, lens, mp.takerFeeBps);
  const crossQty = abs(oppositeFlow) >= abs(size) ? size : size > 0n ? abs(oppositeFlow) : -abs(oppositeFlow);
  const rest = size - crossQty;
  const restPrice = fillPrice(mark, skew, rest, mp.skewScale);
  const crossCost =
    fee(crossQty, mark, mp.crossFeeBps) + abs(((restPrice - mark) * rest) / 10n ** 18n) + fee(rest, restPrice, mp.takerFeeBps);
  return { lensPrice: lens, immediateCost, crossCost, saving: immediateCost - crossCost };
}
