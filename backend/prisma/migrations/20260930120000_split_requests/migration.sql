CREATE TABLE "splits" (
  "id" UUID NOT NULL,
  "organizerId" UUID NOT NULL,
  "chainId" INTEGER NOT NULL,
  "tokenAddress" VARCHAR(42) NOT NULL,
  "organizerAddress" VARCHAR(42) NOT NULL,
  "title" VARCHAR(80),
  "totalAmountUnits" DECIMAL(78,0) NOT NULL,
  "state" VARCHAR(32) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "splits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "split_obligations" (
  "id" UUID NOT NULL,
  "splitId" UUID NOT NULL,
  "participantUserId" UUID NOT NULL,
  "participantAddress" VARCHAR(42) NOT NULL,
  "amountUnits" DECIMAL(78,0) NOT NULL,
  "state" VARCHAR(32) NOT NULL,
  "paymentIntentId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "split_obligations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "splits_organizerId_idempotencyKey_key" ON "splits"("organizerId", "idempotencyKey");
CREATE INDEX "splits_organizerId_createdAt_id_idx" ON "splits"("organizerId", "createdAt", "id");
CREATE INDEX "splits_state_expiresAt_idx" ON "splits"("state", "expiresAt");
CREATE UNIQUE INDEX "split_obligations_paymentIntentId_key" ON "split_obligations"("paymentIntentId");
CREATE UNIQUE INDEX "split_obligations_splitId_participantUserId_key" ON "split_obligations"("splitId", "participantUserId");
CREATE INDEX "split_obligations_participantUserId_state_createdAt_idx" ON "split_obligations"("participantUserId", "state", "createdAt");
ALTER TABLE "splits" ADD CONSTRAINT "splits_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "split_obligations" ADD CONSTRAINT "split_obligations_splitId_fkey" FOREIGN KEY ("splitId") REFERENCES "splits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "split_obligations" ADD CONSTRAINT "split_obligations_participantUserId_fkey" FOREIGN KEY ("participantUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "split_obligations" ADD CONSTRAINT "split_obligations_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
