-- CreateTable
CREATE TABLE "transaction_attempts" (
    "id" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "operationIndex" INTEGER NOT NULL,
    "chainId" INTEGER NOT NULL,
    "txHash" VARCHAR(66) NOT NULL,
    "state" VARCHAR(32) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "submittedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMPTZ(6),
    "blockNumber" BIGINT,
    "blockHash" VARCHAR(66),

    CONSTRAINT "transaction_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transaction_attempts_intentId_operationIndex_idx" ON "transaction_attempts"("intentId", "operationIndex");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_attempts_chainId_txHash_key" ON "transaction_attempts"("chainId", "txHash");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_attempts_intentId_idempotencyKey_key" ON "transaction_attempts"("intentId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "transaction_attempts" ADD CONSTRAINT "transaction_attempts_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
