import { runBars, type Bar, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const FAST = 5;
const SLOW = 18;
const ENTRY_MARGIN_BPS = 8n;
const STOP_BPS = 9_800n;
const MAX_SLIPPAGE_BPS = 150;

interface Trend {
  closes: bigint[];
  fast: bigint | null;
  slow: bigint | null;
  bullish: boolean;
}

const trends = new Map<string, Trend>();

function average(values: readonly bigint[]): bigint {
  return values.reduce((sum, value) => sum + value, 0n) / BigInt(values.length);
}

function update(bar: Bar): Trend {
  let trend = trends.get(bar.symbol);
  if (trend === undefined) {
    trend = { closes: [], fast: null, slow: null, bullish: false };
    trends.set(bar.symbol, trend);
  }

  trend.closes.push(BigInt(bar.c));
  if (trend.closes.length > SLOW) trend.closes.shift();
  trend.fast = trend.closes.length >= FAST ? average(trend.closes.slice(-FAST)) : null;
  trend.slow = trend.closes.length >= SLOW ? average(trend.closes) : null;
  trend.bullish =
    trend.fast !== null &&
    trend.slow !== null &&
    trend.fast * 10_000n >= trend.slow * (10_000n + ENTRY_MARGIN_BPS);
  return trend;
}

function decide(state: BarsState, symbol: string, trend: Trend): OrderInput[] {
  if (state.warmingUp || trend.fast === null || trend.slow === null) return [];

  const held = state.positions.get(symbol);
  if (held !== undefined) {
    const markedValue = state.value(symbol, held.qty);
    const stopHit = markedValue * 10_000n <= held.cost * STOP_BPS;
    if (!trend.bullish || stopHit) {
      return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  if (!trend.bullish || trend.fast <= trend.slow) return [];
  const weightRoom = state.weightRoom(symbol);
  const notional = state.cash < weightRoom ? state.cash : weightRoom;
  if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
  return [{ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onBatch(state, batch) {
    const orders: OrderInput[] = [];
    for (const bar of batch.bars) {
      orders.push(...decide(state, bar.symbol, update(bar)));
    }
    return orders;
  },
});
