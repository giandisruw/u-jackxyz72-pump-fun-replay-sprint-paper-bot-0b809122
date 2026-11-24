// Dip-bounce scalper for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: most pump.fun curves dump hard shortly after launch and then bounce.
// This bot buys the bounce, not the launch: it waits until a curve has fallen
// sharply from its recent high and buy flow is returning, buys a small fixed
// stake, and exits fast on a take-profit, a stop-loss, a trailing stop, or a
// time stop. One entry per curve at a time, at most five open positions.
//
// Every decision is deterministic: no clock, no randomness, no network, no
// environment reads. Iteration follows the batch stream's insertion order.
//
// Fees shape every number here. A round trip pays ~1.25% of size in curve
// fees each way plus 105,000 lamports of tx fees per order, so a 0.06 SOL
// stake costs ~0.0013 SOL (~2.1%) to round-trip. The take-profit (+8%) and
// stop-loss (-4%) are set wide of that cost, and buys smaller than 0.012 SOL
// are skipped because the tx fees alone would eat the trade.
//
// The harness calls onBatch once per slot batch with the slot's events; the
// bot answers with its orders for that slot (they fill two slots later).
// onHello runs once before the first batch; onDone runs once at the end.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------------------
// Tunables (all in SOL, fractions, or slots; 1 slot is about 0.4 s).
// ---------------------------------------------------------------------------

/** SOL put into one position (before the 1%-of-real-reserve cap). */
const STAKE_SOL = 0.06;
/** Smallest buy worth sending: below this the tx fees eat the trade. */
const MIN_BUY_SOL = 0.012;
/** Trades kept per curve tape (covers the whole entry window). */
const TAPE_LEN = 40;
/** Entry window: trades at the tail of the tape the signal reads. */
const WINDOW_TRADES = 30;
/** Minimum trades on a curve before it can be bought. */
const MIN_TRADES = 10;
/** Drop from the window high that counts as a capitulation cliff. */
const CLIFF_DROP = 0.1;
/** Curves that fell further than this are in freefall, not a bounce setup. */
const CLIFF_MAX = 0.25;
/** Bounce off the window low that confirms buyers are returning. */
const BOUNCE_UP = 0.04;
/** Do not chase a bounce already this far off its low. */
const MAX_BOUNCE = 0.1;
/** Recent trades (tail of the tape) whose net SOL must be clearly positive. */
const FLOW_TRADES = 10;
/** Net buy SOL over the flow window that counts as buyers returning. */
const FLOW_MIN_SOL = 0.005;
/** Real SOL reserves a curve must have at entry (skip dust / near-done). */
const MIN_REAL_SOL = 1;
const MAX_REAL_SOL = 40;
/** Exits: take profit, stop loss, trailing stop once armed, time stop. */
const TAKE_PROFIT = 0.08;
const STOP_LOSS = 0.04;
const TRAIL_ARM = 0.07;
const TRAIL_GIVEBACK = 0.03;
/** Slots a position may be held while it is not clearly winning. */
const MAX_HOLD_SLOTS = 600;
/** Slots to wait after an exit before the same curve may be bought again. */
const COOLDOWN_SLOTS = 600;
/** Most entries per curve over the whole run (spread across coins). */
const MAX_ENTRIES_PER_MINT = 1;
/** Most momentum positions open at once (the cap is five). */
const MAX_POSITIONS = 4;
/** Keep this much cash unspent so a late exit never strands the bot. */
const CASH_BUFFER_LAMPORTS = 500_000_000n;
/** Slippage allowed on buys; sells always go out wide so exits land. */
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 10_000;

const LAMPORTS = 1e9;

// ---------------------------------------------------------------------------
// Per-curve tape: the recent trades, in arrival order.
// ---------------------------------------------------------------------------

interface TapeTrade {
  slot: number;
  /** SOL per token at the trade (virtual reserves ratio). */
  price: number;
  /** SOL moved by the trade. */
  sol: number;
  buy: boolean;
  /** Wallet that made the trade (for counting distinct buyers). */
  user: string;
}

interface Tape {
  trades: TapeTrade[];
  createdSlot: number | null;
  complete: boolean;
}

interface Held {
  buySlot: number;
  /** Best mark value seen since the buy, in lamports. */
  peakLamports: bigint;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function tapeHighLow(trades: TapeTrade[]): { high: number; low: number } {
  let high = 0;
  let low = Number.POSITIVE_INFINITY;
  for (const t of trades) {
    if (t.price > high) high = t.price;
    if (t.price < low) low = t.price;
  }
  return { high, low };
}

function netFlow(trades: TapeTrade[], n: number): number {
  let net = 0;
  const start = Math.max(0, trades.length - n);
  for (let i = start; i < trades.length; i++) {
    const t = trades[i]!;
    net += t.buy ? t.sol : -t.sol;
  }
  return net;
}

// ---------------------------------------------------------------------------
// Strategy.
// ---------------------------------------------------------------------------

function createBot(): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const lastExitSlot = new Map<Pubkey, number>();
  const entriesUsed = new Map<Pubkey, number>();

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { trades: [], createdSlot: null, complete: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Mark value of a position now, in lamports, or null when unpriced. */
  const markValue = (state: BotState, mint: Pubkey, tokens: bigint): bigint | null => {
    const curve = state.curves.get(mint);
    if (curve === undefined) return null;
    const p = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (!(p > 0)) return null;
    return BigInt(Math.floor(Number(tokens) * p));
  };

  const onBatch = (state: BotState, batch: Batch): OrderInput[] => {
    const now = batch.slot;
    const orders: OrderInput[] = [];
    const traded = new Set<Pubkey>();

    // Fold this slot's events into the tapes.
    for (const e of batch.events) {
      traded.add(e.mint);
      const t = tapeOf(e.mint);
      if (e.event === 'CreateEvent') {
        t.createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        t.trades.push({
          slot: e.slot,
          price: priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
          sol: Number(e.sol_amount) / LAMPORTS,
          buy: e.is_buy,
          user: e.user,
        });
        if (t.trades.length > TAPE_LEN) t.trades.splice(0, t.trades.length - TAPE_LEN);
      } else {
        t.complete = true;
      }
    }

    // Mints with a buy still in flight: do not double-enter before it lands.
    const pendingBuys = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuys.add(p.order.mint);
    }

    // --- Exits: every held position is re-priced from its curve's marks. ---
    for (const [mint, pos] of state.positions) {
      const value = markValue(state, mint, pos.token_amount);
      if (value === null) continue;
      const h = held.get(mint);
      if (h === undefined) {
        held.set(mint, { buySlot: now, peakLamports: value });
        continue;
      }
      if (value > h.peakLamports) h.peakLamports = value;
      const cost = pos.cost_lamports;
      const up = Number(value - cost) / Number(cost);
      const offPeak = Number(h.peakLamports - value) / Number(h.peakLamports);
      const age = now - h.buySlot;
      let exit = false;
      if (up >= TAKE_PROFIT) exit = true; // bank the bounce
      else if (up <= -STOP_LOSS) exit = true; // cut the loser
      else if (up >= TRAIL_ARM && offPeak >= TRAIL_GIVEBACK) exit = true; // trail the runner
      else if (age >= MAX_HOLD_SLOTS && up <= 0.03) exit = true; // stale, not winning
      if (exit) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        held.delete(mint);
        lastExitSlot.set(mint, now);
      }
    }

    // --- Entries: only curves that traded in this batch. ---
    const openCount = state.committedPositionCount();
    if (openCount < MAX_POSITIONS) {
      const stakeLamports = BigInt(Math.round(STAKE_SOL * LAMPORTS));
      const minBuyLamports = BigInt(Math.round(MIN_BUY_SOL * LAMPORTS));
      let freeCash = state.freeCashLamports() - CASH_BUFFER_LAMPORTS;
      for (const mint of traded) {
        if (orders.length >= 16) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= MAX_POSITIONS) break;
        if (freeCash < minBuyLamports) break;
        const t = tapes.get(mint);
        if (t === undefined || t.complete || t.trades.length < MIN_TRADES) continue;
        if (state.positions.has(mint)) continue;
        if (pendingBuys.has(mint)) continue;
        const used = entriesUsed.get(mint) ?? 0;
        if (used >= MAX_ENTRIES_PER_MINT) continue;
        const lastExit = lastExitSlot.get(mint);
        if (lastExit !== undefined && now - lastExit < COOLDOWN_SLOTS) continue;

        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) continue;

        const window = t.trades.slice(-WINDOW_TRADES);
        const { high, low } = tapeHighLow(window);
        if (!(high > 0) || !(low > 0)) continue;
        const last = window[window.length - 1]!;
        if (!last.buy) continue; // the latest print must itself be a buy
        const drop = (high - last.price) / high;
        if (drop < CLIFF_DROP || drop > CLIFF_MAX) continue; // cliff band, not freefall
        const bounce = (last.price - low) / low;
        if (bounce < BOUNCE_UP || bounce > MAX_BOUNCE) continue; // not bouncing, or chased
        if (netFlow(t.trades, FLOW_TRADES) < FLOW_MIN_SOL) continue; // buyers not returning

        // Size: the fixed stake, capped by 1% of real reserves and by cash.
        let size = stakeLamports;
        const cap = state.maxBuyLamports(mint);
        if (size > cap) size = cap;
        if (size > freeCash) size = freeCash;
        if (size < minBuyLamports) continue;

        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
        freeCash -= size + state.txFeeLamports();
        entriesUsed.set(mint, used + 1);
      }
    }

    return orders;
  };

  return {
    onBatch,
    onDone: () => {
      // Nothing to do: the harness flattens open positions itself.
    },
  };
}

await runBot(createBot());
