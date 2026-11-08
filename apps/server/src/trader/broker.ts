import { toDecimal, type CloseReason, type Money, type Side } from '@trading/shared';
import type { PrismaClient } from '../db/prisma.js';

type Decimal = Money;

export interface EntryFill {
  signalId: string;
  accountId: string;
  strategyId: string;
  instrumentId: string;
  side: Side;
  qty: Decimal;
  price: Decimal;
  stopLoss: Decimal;
  takeProfit: Decimal;
  // The fill's fee in its own currency (USDT for crypto), and the same fee in USD.
  fee: Decimal;
  feeCurrency: string;
  feeUsd: Decimal;
  entryQuoteToUsd: Decimal;
}

export interface OpenedPosition {
  positionId: string;
  orderId: string;
  openedAt: Date;
}

export interface ExitFill {
  positionId: string;
  strategyId: string;
  instrumentId: string;
  // The exit order's side (opposite the position).
  side: Side;
  qty: Decimal;
  price: Decimal;
  reason: CloseReason;
  grossPnlUsd: Decimal;
  fee: Decimal;
  feeCurrency: string;
  feeUsd: Decimal;
  closeQuoteToUsd: Decimal;
}

export interface ClosedPosition {
  realizedPnl: Decimal;
  closedAt: Date;
  balance: Decimal;
}

// Where orders go. PaperBroker fills them on paper; live trading (feature 7) adds a real one.
export interface Broker {
  // Throws on a database error, including the open position unique index (already open).
  openPosition(fill: EntryFill): Promise<OpenedPosition>;
  // Null when the position was already closed (nothing written).
  closePosition(fill: ExitFill): Promise<ClosedPosition | null>;
}

const s = (d: Decimal) => d.toFixed();

// Every fill is ONE SQL statement (data modifying CTEs), so it is atomic and costs one round
// trip to the remote database. Clocks: openedAt, closedAt, filledAt all use the database's now().
export class PaperBroker implements Broker {
  constructor(private readonly prisma: PrismaClient) {}

  // Marks the signal `ordered` and writes Position, Order (e:<signalId>), and Fill together.
  // The balance doesn't move at entry; the entry fee sits in Position.fees until the close.
  async openPosition(f: EntryFill): Promise<OpenedPosition> {
    const rows = await this.prisma.$queryRaw<OpenedPosition[]>`
      WITH sig AS (
        UPDATE "Signal" SET outcome = 'ordered', "skipReason" = NULL WHERE id = ${f.signalId}::uuid RETURNING id
      ),
      pos AS (
        INSERT INTO "Position" (id, "accountId", "instrumentId", "strategyId", side, qty, "entryPrice",
          "stopLoss", "takeProfit", status, fees, "entryQuoteToUsd", "unrealizedPnl")
        SELECT gen_random_uuid(), ${f.accountId}::uuid, ${f.instrumentId}::uuid, ${f.strategyId}::uuid,
          ${f.side}::"Side", ${s(f.qty)}::numeric, ${s(f.price)}::numeric, ${s(f.stopLoss)}::numeric,
          ${s(f.takeProfit)}::numeric, 'open', ${s(f.feeUsd)}::numeric, ${s(f.entryQuoteToUsd)}::numeric,
          0 - ${s(f.feeUsd)}::numeric
        FROM sig
        RETURNING id, "openedAt"
      ),
      ord AS (
        INSERT INTO "Order" (id, "clientOrderId", "accountId", "strategyId", "instrumentId", "signalId",
          side, type, qty, status, reason, "positionId", "updatedAt")
        SELECT gen_random_uuid(), 'e:' || ${f.signalId}, ${f.accountId}::uuid, ${f.strategyId}::uuid,
          ${f.instrumentId}::uuid, ${f.signalId}::uuid, ${f.side}::"Side", 'market', ${s(f.qty)}::numeric,
          'filled', 'entry', pos.id, now()
        FROM pos
        RETURNING id
      ),
      fill AS (
        INSERT INTO "Fill" (id, "orderId", price, qty, fee, "feeCurrency", "filledAt")
        SELECT gen_random_uuid(), ord.id, ${s(f.price)}::numeric, ${s(f.qty)}::numeric, ${s(f.fee)}::numeric,
          ${f.feeCurrency}, now()
        FROM ord
        RETURNING id
      )
      SELECT pos.id AS "positionId", ord.id AS "orderId", pos."openedAt" FROM pos, ord, fill`;
    const opened = rows[0];
    if (!opened) throw new Error(`signal ${f.signalId} not found, entry not written`);
    return opened;
  }

  // Closes only an open position (the guarded UPDATE), fills the exit order x:<positionId>
  // (creating it, or filling a pending kill order), and adds realizedPnl to the balance.
  // realizedPnl = gross − (fees so far + exit fee), rounded once by the column, and the balance
  // moves by exactly that stored value.
  async closePosition(f: ExitFill): Promise<ClosedPosition | null> {
    const rows = await this.prisma.$queryRaw<ClosedPosition[]>`
      WITH pos AS (
        UPDATE "Position" SET status = 'closed', "exitPrice" = ${s(f.price)}::numeric,
          "closeReason" = ${f.reason}::"OrderReason", "closeQuoteToUsd" = ${s(f.closeQuoteToUsd)}::numeric,
          fees = fees + ${s(f.feeUsd)}::numeric,
          "realizedPnl" = ${s(f.grossPnlUsd)}::numeric - (fees + ${s(f.feeUsd)}::numeric),
          "closedAt" = now()
        WHERE id = ${f.positionId}::uuid AND status = 'open'
        RETURNING id, "accountId", "realizedPnl", "closedAt"
      ),
      ord AS (
        INSERT INTO "Order" (id, "clientOrderId", "accountId", "strategyId", "instrumentId", side, type, qty,
          status, reason, "positionId", "updatedAt")
        SELECT gen_random_uuid(), 'x:' || pos.id, pos."accountId", ${f.strategyId}::uuid, ${f.instrumentId}::uuid,
          ${f.side}::"Side", 'market', ${s(f.qty)}::numeric, 'filled', ${f.reason}::"OrderReason", pos.id, now()
        FROM pos
        ON CONFLICT ("clientOrderId") DO UPDATE SET status = 'filled', "updatedAt" = now()
        RETURNING id
      ),
      fill AS (
        INSERT INTO "Fill" (id, "orderId", price, qty, fee, "feeCurrency", "filledAt")
        SELECT gen_random_uuid(), ord.id, ${s(f.price)}::numeric, ${s(f.qty)}::numeric, ${s(f.fee)}::numeric,
          ${f.feeCurrency}, now()
        FROM ord
        RETURNING id
      ),
      acc AS (
        UPDATE "Account" a SET balance = a.balance + pos."realizedPnl" FROM pos WHERE a.id = pos."accountId"
        RETURNING a.balance
      )
      SELECT pos."realizedPnl", pos."closedAt", acc.balance FROM pos, acc, fill`;
    const row = rows[0];
    if (!row) return null;
    // Prisma returns its own Decimal class; convert to the shared one.
    return { realizedPnl: toDecimal(row.realizedPnl.toFixed()), closedAt: row.closedAt, balance: toDecimal(row.balance.toFixed()) };
  }
}

// True when a database error is the open position unique index (spec 0003: already open).
export function isOpenPositionConflict(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : String(err);
  return text.includes('Position_open_strategy_instrument_key');
}
