-- AlterEnum
ALTER TYPE "CommandType" ADD VALUE 'enable_strategy';
ALTER TYPE "CommandType" ADD VALUE 'disable_strategy';
ALTER TYPE "CommandType" ADD VALUE 'close_position';

-- AlterEnum
ALTER TYPE "OrderReason" ADD VALUE 'manual';

-- AlterTable
ALTER TABLE "BotCommand" ADD COLUMN     "positionId" UUID,
ADD COLUMN     "strategyId" UUID;

-- AddForeignKey
ALTER TABLE "BotCommand" ADD CONSTRAINT "BotCommand_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotCommand" ADD CONSTRAINT "BotCommand_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A command's target matches its type (spec 0004). Compared as text, because Postgres can't
-- use an enum value in the same transaction that adds it. Prisma can't express a CHECK, so
-- it lives here only.
ALTER TABLE "BotCommand" ADD CONSTRAINT "BotCommand_target_check" CHECK (
  ("strategyId" IS NOT NULL) = (type::text IN ('enable_strategy', 'disable_strategy'))
  AND ("positionId" IS NOT NULL) = (type::text = 'close_position')
);
