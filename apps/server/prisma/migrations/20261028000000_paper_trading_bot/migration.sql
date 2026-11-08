-- CreateEnum
CREATE TYPE "OrderReason" AS ENUM ('entry', 'stop_loss', 'take_profit', 'opposite_signal', 'kill');

-- AlterTable
ALTER TABLE "RiskSettings" ADD COLUMN     "riskPerTradePct" DECIMAL(10,4) NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "positionId" UUID,
ADD COLUMN     "reason" "OrderReason" NOT NULL;

-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "closeQuoteToUsd" DECIMAL(30,12),
ADD COLUMN     "closeReason" "OrderReason",
ADD COLUMN     "entryQuoteToUsd" DECIMAL(30,12) NOT NULL,
ADD COLUMN     "exitPrice" DECIMAL(30,12),
ADD COLUMN     "fees" DECIMAL(30,12) NOT NULL DEFAULT 0,
ADD COLUMN     "markPrice" DECIMAL(30,12),
ADD COLUMN     "markedAt" TIMESTAMPTZ(3),
ADD COLUMN     "unrealizedPnl" DECIMAL(30,12);

-- CreateTable
CREATE TABLE "EquitySnapshot" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "balance" DECIMAL(30,12) NOT NULL,
    "equity" DECIMAL(30,12) NOT NULL,
    "openPositions" INTEGER NOT NULL,
    "takenAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EquitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EquitySnapshot_accountId_takenAt_key" ON "EquitySnapshot"("accountId", "takenAt");

-- CreateIndex
CREATE UNIQUE INDEX "Signal_strategyId_instrumentId_candleTime_key" ON "Signal"("strategyId", "instrumentId", "candleTime");

-- CreateIndex
CREATE INDEX "Order_positionId_idx" ON "Order"("positionId");

-- AddForeignKey
ALTER TABLE "EquitySnapshot" ADD CONSTRAINT "EquitySnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one open position per (strategy, instrument), spec 0003. Prisma can't express a
-- partial index, so it lives here only.
CREATE UNIQUE INDEX "Position_open_strategy_instrument_key" ON "Position"("strategyId", "instrumentId") WHERE status = 'open';
