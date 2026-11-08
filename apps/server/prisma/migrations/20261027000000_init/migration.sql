-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AssetClass" AS ENUM ('crypto', 'forex');

-- CreateEnum
CREATE TYPE "AccountMode" AS ENUM ('paper', 'live');

-- CreateEnum
CREATE TYPE "Side" AS ENUM ('buy', 'sell');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('market', 'limit', 'stop');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'open', 'partially_filled', 'filled', 'canceled', 'rejected');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "SignalOutcome" AS ENUM ('ordered', 'skipped');

-- CreateEnum
CREATE TYPE "BotState" AS ENUM ('idle', 'running', 'killed');

-- CreateEnum
CREATE TYPE "CommandType" AS ENUM ('start', 'stop', 'kill');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('pending', 'done', 'failed');

-- CreateTable
CREATE TABLE "Instrument" (
    "id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "assetClass" "AssetClass" NOT NULL,
    "venue" TEXT NOT NULL,
    "baseAsset" TEXT NOT NULL,
    "quoteAsset" TEXT NOT NULL,
    "tickSize" DECIMAL(30,12) NOT NULL,
    "minQty" DECIMAL(30,12) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Instrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candle" (
    "instrumentId" UUID NOT NULL,
    "timeframe" TEXT NOT NULL,
    "openTime" TIMESTAMPTZ(3) NOT NULL,
    "open" DECIMAL(30,12) NOT NULL,
    "high" DECIMAL(30,12) NOT NULL,
    "low" DECIMAL(30,12) NOT NULL,
    "close" DECIMAL(30,12) NOT NULL,
    "volume" DECIMAL(30,12) NOT NULL,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("instrumentId","timeframe","openTime")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "AccountMode" NOT NULL,
    "venue" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "balance" DECIMAL(30,12) NOT NULL,
    "equity" DECIMAL(30,12) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Strategy" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "timeframe" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "accountId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyInstrument" (
    "strategyId" UUID NOT NULL,
    "instrumentId" UUID NOT NULL,

    CONSTRAINT "StrategyInstrument_pkey" PRIMARY KEY ("strategyId","instrumentId")
);

-- CreateTable
CREATE TABLE "RiskSettings" (
    "strategyId" UUID NOT NULL,
    "stopLossPct" DECIMAL(10,4) NOT NULL,
    "takeProfitPct" DECIMAL(10,4) NOT NULL,
    "maxPositionSize" DECIMAL(30,12) NOT NULL,
    "maxOpenTrades" INTEGER NOT NULL,
    "dailyLossLimit" DECIMAL(30,12) NOT NULL,

    CONSTRAINT "RiskSettings_pkey" PRIMARY KEY ("strategyId")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" UUID NOT NULL,
    "strategyId" UUID NOT NULL,
    "instrumentId" UUID NOT NULL,
    "side" "Side" NOT NULL,
    "indicators" JSONB NOT NULL,
    "outcome" "SignalOutcome" NOT NULL,
    "skipReason" TEXT,
    "candleTime" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "clientOrderId" TEXT NOT NULL,
    "accountId" UUID NOT NULL,
    "strategyId" UUID NOT NULL,
    "instrumentId" UUID NOT NULL,
    "signalId" UUID,
    "side" "Side" NOT NULL,
    "type" "OrderType" NOT NULL,
    "qty" DECIMAL(30,12) NOT NULL,
    "price" DECIMAL(30,12),
    "status" "OrderStatus" NOT NULL DEFAULT 'pending',
    "venueOrderId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fill" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "price" DECIMAL(30,12) NOT NULL,
    "qty" DECIMAL(30,12) NOT NULL,
    "fee" DECIMAL(30,12) NOT NULL,
    "feeCurrency" TEXT NOT NULL,
    "filledAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Fill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "instrumentId" UUID NOT NULL,
    "strategyId" UUID NOT NULL,
    "side" "Side" NOT NULL,
    "qty" DECIMAL(30,12) NOT NULL,
    "entryPrice" DECIMAL(30,12) NOT NULL,
    "stopLoss" DECIMAL(30,12),
    "takeProfit" DECIMAL(30,12),
    "status" "PositionStatus" NOT NULL DEFAULT 'open',
    "realizedPnl" DECIMAL(30,12),
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotRun" (
    "id" UUID NOT NULL,
    "state" "BotState" NOT NULL DEFAULT 'idle',
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMPTZ(3),
    "stopReason" TEXT,
    "lastHeartbeatAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotCommand" (
    "id" UUID NOT NULL,
    "type" "CommandType" NOT NULL,
    "status" "CommandStatus" NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handledAt" TIMESTAMPTZ(3),

    CONSTRAINT "BotCommand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_venue_symbol_key" ON "Instrument"("venue", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "Account_name_key" ON "Account"("name");

-- CreateIndex
CREATE INDEX "Signal_strategyId_createdAt_idx" ON "Signal"("strategyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_clientOrderId_key" ON "Order"("clientOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_signalId_key" ON "Order"("signalId");

-- CreateIndex
CREATE INDEX "Order_accountId_status_idx" ON "Order"("accountId", "status");

-- CreateIndex
CREATE INDEX "Fill_orderId_idx" ON "Fill"("orderId");

-- CreateIndex
CREATE INDEX "Position_accountId_status_idx" ON "Position"("accountId", "status");

-- CreateIndex
CREATE INDEX "BotRun_startedAt_idx" ON "BotRun"("startedAt");

-- CreateIndex
CREATE INDEX "BotCommand_status_createdAt_idx" ON "BotCommand"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "Candle" ADD CONSTRAINT "Candle_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Strategy" ADD CONSTRAINT "Strategy_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyInstrument" ADD CONSTRAINT "StrategyInstrument_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyInstrument" ADD CONSTRAINT "StrategyInstrument_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskSettings" ADD CONSTRAINT "RiskSettings_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
