-- CreateEnum
CREATE TYPE "FeedState" AS ENUM ('backfilling', 'live', 'stale', 'closed', 'error');

-- AlterTable
ALTER TABLE "Instrument" ADD COLUMN     "venueSymbol" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "FeedStatus" (
    "instrumentId" UUID NOT NULL,
    "status" "FeedState" NOT NULL DEFAULT 'backfilling',
    "lastTickAt" TIMESTAMPTZ(3),
    "lastCandleAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedStatus_pkey" PRIMARY KEY ("instrumentId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_venue_venueSymbol_key" ON "Instrument"("venue", "venueSymbol");

-- AddForeignKey
ALTER TABLE "FeedStatus" ADD CONSTRAINT "FeedStatus_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
