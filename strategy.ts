// Hot-launch scalper for the pump.fun bonding-curve replay
// (agent-fun/replay/v2). Written from scratch in this session.
//
// What the dev data showed (1222 universe coins, 24h window):
//  - A curve's price is ((30 + realSol) / 30) ^ 2 times its create price,
//    because virtual SOL is 30 SOL plus real SOL. The price can never fall
//    below the create price, and it reverts toward it as real SOL drains.
//    Most coins pump in a 1-3 slot burst right after creation and then
//    bleed back toward 1.0x, so buying after the burst and holding loses.
//  - The pilot momentum bot lost ~9.7 SOL on this window chasing those
//    bursts; the pilot sniper lost ~0.48 SOL buying launches with tiny,
//    fee-drowned stakes; a plain take-profit/stop-loss on first-lift
//    entries lost ~1 SOL. Every broad rule loses after the 2-slot
//    latency and the 105k-lamport tx fee.
//  - One slice stays positive: launches with at least 10 buys in their
//    first 3 slots ("hot launches", 67 of 1222 coins). Entered at the
//    create+3 price with a +12% take-profit, -12% stop-loss and a 40-slot
//    hold cap, they average about +6% per trade before fees (win rate
//    ~58%). The edge is the crowd: ten early buys mean the burst has
//    legs, so the price usually runs a little further before reverting.
//  - So this bot ONLY trades hot launches. It watches each coin's first
//    3 slots, decides on the first batch at create+3, buys up to the
//    1%-of-real-reserve cap (hot coins grow real SOL fast, so the cap
//    soon allows a real stake), and exits fast: +12%, -12%, or 40 slots.
//    Buys use tight slippage (200 bps): a fill more than 2% worse than
//    the decision price is rejected for free instead of buying a burst
//    top. Sells go wide open so exits always fill. One round trip per
//    mint, no re-entry, at most 5 open positions (the harness cap).
//    A second "warm" tier (creator bought 0.05-1 SOL and at least 3
//    distinct buyers in the first 3 slots) trades at a smaller stake to
//    keep the 20-mint guardrail safe on short windows.
//
// Pure function of the batches: no clock, no randomness, no I/O.
// Iteration is over insertion-ordered maps, with held mints sorted
// before exits, so the two graded executions agree byte for byte.

export interface Params {
  /** Slots of tape to judge a launch on (create .. create+window-1). */
  hotWindow: number;
  /** Hot tier: at least this many buys in the window. */
  hotMinBuys: number;
  /** Warm tier: creator buy in this range (lamports) + minBuyers. */
  warmDevBuyMin: bigint;
  warmDevBuyMax: bigint;
  warmMinBuyers: number;
  /** Target total spend per hot position (lamports). */
  hotStake: bigint;
  /** Target total spend per warm position (lamports). */
  warmStake: bigint;
  /** Smallest single buy worth the tx fee (lamports). */
  minBuy: bigint;
  /** Sell all once liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Sell all once liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Sell all after holding this many slots, whatever the price. */
  maxHold: number;
  /** Most new entries decided in one batch. */
  maxEntriesPerBatch: number;
  /** Slippage tolerance on buys (bps). Sells always go wide open. */
  buySlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  hotWindow: 3,
  hotMinBuys: 10,
  warmDevBuyMin: 50_000_000n,
  warmDevBuyMax: 1_000_000_000n,
  warmMinBuyers: 3,
  hotStake: 500_000_000n,
  warmStake: 100_000_000n,
  minBuy: 5_000_000n,
  takeProfit: 0.12,
  stopLoss: 0.12,
  maxHold: 40,
  maxEntriesPerBatch: 2,
  buySlippageBps: 200,
};

const BPS = 10_000n;
/** Curve fees: protocol 95 bps + creator 30 bps (fallback schedule). */
const FEE_BPS = 125n;

export interface CurveView {
  virtual_token_reserves: bigint;
  virtual_quote_reserves: bigint;
  real_quote_reserves: bigint;
  complete: boolean;
}

export interface HoldingView {
  token_amount: bigint;
  cost_lamports: bigint;
}

/** Minimal state surface the strategy needs. The kit's BotState and the
 *  entrypoint's own MiniState both satisfy it structurally. */
export interface StrategyState {
  hello: {
    capital: { lamports: string };
    caps: { max_open_positions: number; max_orders_per_batch: number };
  };
  cash: bigint;
  positions: Map<string, HoldingView>;
  curves: Map<string, CurveView>;
  pending: Map<string, { order: { side: string; mint: string } }>;
  maxBuyLamports(mint: string): bigint;
  freeCashLamports(): bigint;
  committedPositionCount(): number;
  txFeeLamports(): bigint;
}

export interface BatchView {
  slot: number;
  events: {
    event: string;
    mint: string;
    slot: number;
    is_buy?: boolean;
    sol_amount?: string;
    user?: string;
    creator?: string;
  }[];
  fills: { mint: string; side: string; status: string }[];
}

export interface OrderOut {
  side: 'buy' | 'sell';
  mint: string;
  quote_lamports?: bigint | string;
  token_amount?: bigint | string;
  max_slippage_bps: number;
}

/** What selling `tokens` against (vq, vt) pays after curve fees. */
export function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n || vq <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  const fee = (q * FEE_BPS + BPS - 1n) / BPS;
  return q > fee ? q - fee : 0n;
}

interface Coin {
  created: number;
  creator: string;
  buys: number;
  buyers: Set<string>;
  devBuy: bigint;
  decided: boolean;
  entrySlot: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<string, Coin>();
  const coin = (mint: string): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { created: -1, creator: '', buys: 0, buyers: new Set(), devBuy: 0n, decided: false, entrySlot: -1 };
      coins.set(mint, c);
    }
    return c;
  };

  return function onBatch(state: StrategyState, batch: BatchView): OrderOut[] {
    const slot = batch.slot;
    const tx = state.txFeeLamports();
    const cap = state.hello.caps.max_orders_per_batch;
    const orders: OrderOut[] = [];
    const pendingMints = new Set<string>();
    for (const o of state.pending.values()) pendingMints.add(o.order.mint);

    // Tape the batch's events first (insertion order = batch order).
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const c = coin(e.mint);
        c.created = e.slot;
        c.creator = e.creator ?? '';
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined || c.created < 0) continue;
        if (e.slot > c.created + p.hotWindow - 1) continue;
        if (e.is_buy) {
          c.buys += 1;
          if (e.user !== undefined && e.user !== c.creator) c.buyers.add(e.user);
          if (e.user !== undefined && e.user === c.creator && e.sol_amount !== undefined) {
            c.devBuy += BigInt(e.sol_amount);
          }
        }
      }
    }

    // 1. Exits on held positions, mint order sorted.
    const held = [...state.positions.keys()].sort();
    for (const mint of held) {
      if (orders.length >= cap) break;
      const h = state.positions.get(mint)!;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingMints.has(mint)) continue;
      const c = coin(mint);
      const value = sellValue(h.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const gain = h.cost_lamports > 0n ? Number(value - h.cost_lamports) / Number(h.cost_lamports) : 0;
      const stale = c.entrySlot >= 0 && slot - c.entrySlot >= p.maxHold;
      if (gain >= p.takeProfit || gain <= -p.stopLoss || stale) {
        orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: 10000 });
        pendingMints.add(mint);
      }
    }

    // 2. New entries: coins whose judging window just closed (first batch
    // at create+window), hot tier first, then warm tier.
    let entries = 0;
    let open = state.committedPositionCount();
    for (const e of batch.events) {
      if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
      if (open >= state.hello.caps.max_open_positions) break;
      if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      const c = coins.get(mint);
      if (c === undefined || c.created < 0 || c.decided) continue;
      if (slot < c.created + p.hotWindow) continue;
      c.decided = true;
      if (state.positions.has(mint) || pendingMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const hot = c.buys >= p.hotMinBuys;
      const warm =
        !hot &&
        c.devBuy >= p.warmDevBuyMin &&
        c.devBuy <= p.warmDevBuyMax &&
        c.buyers.size >= p.warmMinBuyers;
      if (!hot && !warm) continue;
      const stake = hot ? p.hotStake : p.warmStake;
      let amount = stake;
      const sizeCap = state.maxBuyLamports(mint);
      if (amount > sizeCap) amount = sizeCap;
      if (amount < p.minBuy) continue;
      if (state.freeCashLamports() - amount - tx < 0n) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      c.entrySlot = slot;
      pendingMints.add(mint);
      entries += 1;
      open += 1;
    }
    return orders;
  };
}
