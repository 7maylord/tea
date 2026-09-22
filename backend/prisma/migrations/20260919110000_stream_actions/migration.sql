CREATE TABLE "stream_actions" (
  "id" UUID NOT NULL,
  "intentId" UUID NOT NULL,
  "chainId" INTEGER NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
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
  CONSTRAINT "stream_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stream_actions_intentId_idempotencyKey_key" ON "stream_actions"("intentId", "idempotencyKey");
CREATE UNIQUE INDEX "stream_actions_chainId_txHash_key" ON "stream_actions"("chainId", "txHash");
CREATE INDEX "stream_actions_intentId_createdAt_id_idx" ON "stream_actions"("intentId", "createdAt", "id");
ALTER TABLE "stream_actions" ADD CONSTRAINT "stream_actions_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
