import { runBars } from './vendor/makefun-bars.ts';

const symbol = 'CBBTC';
const allocationNumerator = 999n;
const allocationDenominator = 1_000n;
const maxSlippageBps = 10_000;

let pendingClientId: string | null = null;

await runBars({
  onBatch(state, batch) {
    if (pendingClientId !== null) {
      const result = batch.fills.find((fill) => fill.client_id === pendingClientId);
      if (result !== undefined) pendingClientId = null;
    }

    if (state.warmingUp || state.positions.has(symbol) || pendingClientId !== null) return [];
    if (!batch.bars.some((bar) => bar.symbol === symbol)) return [];

    const weightRoom = state.weightRoom(symbol);
    const allocatedCash = (state.cash * allocationNumerator) / allocationDenominator;
    const notional = allocatedCash < weightRoom ? allocatedCash : weightRoom;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];

    const clientId = `entry-${batch.seq}`;
    pendingClientId = clientId;
    return [{
      side: 'buy',
      symbol,
      notional_quote_units: notional,
      max_slippage_bps: maxSlippageBps,
      client_id: clientId,
    }];
  },
});
