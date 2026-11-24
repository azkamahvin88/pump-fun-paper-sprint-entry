// Hot-launch scalper for make.fun "Pump.fun Paper Sprint: Any Bot Can Win"
// (harness pumpfun-replay/v2, protocol agent-fun/replay/v2).
//
// Entrypoint: `node main.ts` (Node 22, no dependencies, no build step).
// The strategy lives in strategy.ts; this file is only the wire: it speaks
// the harness protocol on stdin/stdout (one JSON line per message, one
// reply per batch), keeps the account/curve/pending state the strategy
// reads, and validates orders the way the harness would, so a broken
// order fails here instead of in grading. Diagnostics go to stderr;
// stdout carries replies only.
//
// Deterministic by construction: no clock, no Math.random, no environment
// reads. The only "randomness" the protocol allows (hello.seed) is unused
// because the strategy needs none. Two executions over the same replay
// therefore produce byte-identical action logs.

import { createStrategy } from './strategy.ts';

const PROTOCOL = 'agent-fun/replay/v2';
const BPS = 10_000n;
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;

type Pubkey = string;

interface Curve {
  mint: Pubkey;
  virtual_token_reserves: bigint;
  virtual_quote_reserves: bigint;
  real_token_reserves: bigint;
  real_quote_reserves: bigint;
  complete: boolean;
  reserves_slot: number;
}

interface Holding {
  token_amount: bigint;
  cost_lamports: bigint;
}

interface PendingOrder {
  order: { side: string; mint: string; client_id: string };
  seq: number;
  decided_slot: number;
}

/** Minimal bot state: the exact surface strategy.ts reads. */
class MiniState {
  hello: any;
  seq = -1;
  slot = -1;
  cash = 0n;
  positions = new Map<Pubkey, Holding>();
  curves = new Map<Pubkey, Curve>();
  pending = new Map<string, PendingOrder>();
  #used = new Set<string>();
  #next = 1;

  constructor(hello: any) {
    this.hello = hello;
    this.cash = BigInt(hello.capital.lamports);
  }

  txFeeLamports(): bigint {
    return BigInt(this.hello.fees.base_fee_lamports) + BigInt(this.hello.fees.priority_fee_lamports);
  }

  maxBuyLamports(mint: Pubkey): bigint {
    const c = this.curves.get(mint);
    if (c === undefined || c.complete) return 0n;
    return (c.real_quote_reserves * BigInt(this.hello.caps.max_order_bps_of_real_reserve)) / BPS;
  }

  committedPositionCount(): number {
    const mints = new Set<Pubkey>(this.positions.keys());
    for (const p of this.pending.values()) if (p.order.side === 'buy') mints.add(p.order.mint);
    return mints.size;
  }

  freeCashLamports(): bigint {
    const tx = this.txFeeLamports();
    let free = this.cash;
    for (const p of this.pending.values()) {
      free -= tx;
      if (p.order.side === 'buy') {
        const o = p.order as { quote_lamports?: string };
        if (o.quote_lamports !== undefined) free -= BigInt(o.quote_lamports);
      }
    }
    return free;
  }

  applyBatch(batch: any): void {
    this.seq = batch.seq;
    this.slot = batch.slot;
    for (const f of batch.fills) this.pending.delete(f.client_id);
    this.cash = BigInt(batch.account.cash_lamports);
    this.positions.clear();
    for (const p of batch.account.positions) {
      const tokens = BigInt(p.token_amount);
      if (tokens > 0n) {
        this.positions.set(p.mint, { token_amount: tokens, cost_lamports: BigInt(p.cost_lamports) });
      }
    }
    for (const m of batch.marks) {
      const c = this.curves.get(m.mint);
      if (c !== undefined && m.slot < c.reserves_slot) continue;
      const curve = c ?? this.#newCurve(m.mint, m.slot);
      curve.virtual_token_reserves = BigInt(m.virtual_token_reserves);
      curve.virtual_quote_reserves = BigInt(m.virtual_quote_reserves);
      curve.real_token_reserves = BigInt(m.real_token_reserves);
      curve.real_quote_reserves = BigInt(m.real_quote_reserves);
      curve.reserves_slot = m.slot;
    }
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const curve = this.#newCurve(e.mint, e.slot);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
        curve.real_token_reserves = BigInt(e.real_token_reserves);
        curve.real_quote_reserves = 0n;
      } else if (e.event === 'TradeEvent') {
        const curve = this.curves.get(e.mint) ?? this.#newCurve(e.mint, e.slot);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
        curve.real_token_reserves = BigInt(e.real_token_reserves);
        curve.real_quote_reserves = BigInt(e.real_quote_reserves);
        curve.reserves_slot = e.slot;
      } else {
        const curve = this.curves.get(e.mint) ?? this.#newCurve(e.mint, e.slot);
        curve.complete = true;
      }
    }
  }

  applyDone(done: any): void {
    this.seq = done.seq;
    this.cash = BigInt(done.account.cash_lamports);
    this.positions.clear();
    for (const p of done.account.positions) {
      const tokens = BigInt(p.token_amount);
      if (tokens > 0n) {
        this.positions.set(p.mint, { token_amount: tokens, cost_lamports: BigInt(p.cost_lamports) });
      }
    }
  }

  /** Validate the strategy's orders and turn them into wire orders. */
  toOrders(result: unknown): any[] {
    if (result === undefined || result === null) return [];
    if (!Array.isArray(result)) throw new Error(`batch ${this.seq}: onBatch must return an array of orders`);
    const cap = this.hello.caps.max_orders_per_batch;
    if (result.length > cap) {
      throw new Error(`batch ${this.seq}: ${result.length} orders over max_orders_per_batch (${cap})`);
    }
    const taken = new Set<string>();
    return result.map((o: any, i: number) => {
      const where = `batch ${this.seq} order ${i}`;
      if (typeof o !== 'object' || o === null) throw new Error(`${where}: expected an order object`);
      if (o.side !== 'buy' && o.side !== 'sell') throw new Error(`${where}: side must be "buy" or "sell"`);
      if (typeof o.mint !== 'string' || !PUBKEY_RE.test(o.mint)) throw new Error(`${where}: bad mint`);
      const amountKey = o.side === 'buy' ? 'quote_lamports' : 'token_amount';
      const amount = toU64(o[amountKey], `${where}: ${amountKey}`);
      const bps = o.max_slippage_bps;
      if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
        throw new Error(`${where}: max_slippage_bps must be an integer 0..10000`);
      }
      let client_id: string;
      if (o.client_id !== undefined) {
        if (typeof o.client_id !== 'string' || !CLIENT_ID_RE.test(o.client_id)) {
          throw new Error(`${where}: bad client_id`);
        }
        client_id = o.client_id;
      } else {
        do {
          client_id = `o${this.#next++}`;
        } while (this.#used.has(client_id) || taken.has(client_id));
      }
      if (taken.has(client_id)) throw new Error(`${where}: duplicate client_id ${client_id}`);
      taken.add(client_id);
      return o.side === 'buy'
        ? { side: 'buy', client_id, mint: o.mint, quote_lamports: amount, max_slippage_bps: bps }
        : { side: 'sell', client_id, mint: o.mint, token_amount: amount, max_slippage_bps: bps };
    });
  }

  recordOrders(orders: readonly any[]): void {
    for (const order of orders) {
      this.#used.add(order.client_id);
      this.pending.set(order.client_id, { order, seq: this.seq, decided_slot: this.slot });
    }
  }

  #newCurve(mint: Pubkey, slot: number): Curve {
    const curve: Curve = {
      mint,
      virtual_token_reserves: 0n,
      virtual_quote_reserves: 0n,
      real_token_reserves: 0n,
      real_quote_reserves: 0n,
      complete: false,
      reserves_slot: slot,
    };
    this.curves.set(mint, curve);
    return curve;
  }
}

function toU64(value: unknown, what: string): string {
  let n: bigint | null = null;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'string' && U64_RE.test(value)) n = BigInt(value);
  if (n === null || n < 0n || n > 18_446_744_073_709_551_615n) {
    throw new Error(`${what} must be a u64, got ${String(value)}`);
  }
  return n.toString();
}

async function* readLines(input: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buf = Buffer.alloc(0);
  for await (const chunk of input) {
    buf = Buffer.concat([buf, Buffer.from(chunk)]);
    let idx: number;
    while ((idx = buf.indexOf(0x0a)) !== -1) {
      let line = buf.subarray(0, idx);
      buf = buf.subarray(idx + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      yield decoder.decode(line);
    }
  }
  if (buf.length > 0) yield decoder.decode(buf);
}

const onBatch = createStrategy();
let state: MiniState | null = null;
let batches = 0;

for await (const line of readLines(process.stdin as unknown as AsyncIterable<Uint8Array>)) {
  if (line.trim() === '') continue;
  const msg = JSON.parse(line);
  if (msg.type === 'hello') {
    if (state !== null) throw new Error('second hello');
    if (msg.protocol !== PROTOCOL) throw new Error(`harness speaks ${msg.protocol}; this bot speaks ${PROTOCOL}`);
    state = new MiniState(msg);
  } else if (msg.type === 'batch') {
    if (state === null) throw new Error('batch before hello');
    state.applyBatch(msg);
    const orders = state.toOrders(onBatch(state as never, msg));
    const reply = JSON.stringify({ type: 'reply', seq: msg.seq, orders });
    state.recordOrders(orders);
    process.stdout.write(`${reply}\n`);
    batches++;
  } else if (msg.type === 'done') {
    if (state === null) throw new Error('done before hello');
    state.applyDone(msg);
    console.error(`done after ${batches} batches; final cash ${state.cash} lamports`);
    break;
  } else {
    throw new Error(`unknown message type ${msg.type}`);
  }
}
if (state === null) throw new Error('input ended before hello');
