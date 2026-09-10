-- CreateTable
CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL,
    "payerId" UUID NOT NULL,
    "recipientUserId" UUID,
    "chainId" INTEGER NOT NULL,
    "tokenAddress" VARCHAR(42) NOT NULL,
    "payerAddress" VARCHAR(42) NOT NULL,
    "recipientAddress" VARCHAR(42) NOT NULL,
    "amountUnits" DECIMAL(78,0) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "state" VARCHAR(32) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "authorizationExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_intents_payerId_state_authorizationExpiresAt_idx" ON "payment_intents"("payerId", "state", "authorizationExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_payerId_idempotencyKey_key" ON "payment_intents"("payerId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
