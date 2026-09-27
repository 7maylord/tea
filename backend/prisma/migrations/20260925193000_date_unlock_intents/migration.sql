ALTER TABLE "payment_intents"
  ADD COLUMN "dateUnlockAddress" VARCHAR(42),
  ADD COLUMN "unlockAt" TIMESTAMPTZ(6),
  ADD COLUMN "dateLockId" DECIMAL(78, 0);

CREATE TABLE "date_unlock_actions" (
  "id" UUID NOT NULL,
  "intentId" UUID NOT NULL,
  "chainId" INTEGER NOT NULL,
  "actorAddress" VARCHAR(42) NOT NULL,
  "state" VARCHAR(32) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "preparedAtBlock" BIGINT NOT NULL,
  "txHash" VARCHAR(66),
  "submissionKey" VARCHAR(128),
  "submissionHash" CHAR(64),
  "amountUnits" DECIMAL(78,0),
  "blockNumber" BIGINT,
  "blockHash" VARCHAR(66),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "date_unlock_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "date_unlock_actions_intentId_idempotencyKey_key" ON "date_unlock_actions"("intentId", "idempotencyKey");
CREATE UNIQUE INDEX "date_unlock_actions_chainId_txHash_key" ON "date_unlock_actions"("chainId", "txHash");
CREATE INDEX "date_unlock_actions_intentId_createdAt_id_idx" ON "date_unlock_actions"("intentId", "createdAt", "id");
ALTER TABLE "date_unlock_actions" ADD CONSTRAINT "date_unlock_actions_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
