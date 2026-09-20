ALTER TABLE "payment_intents" ALTER COLUMN "idempotencyKey" DROP NOT NULL;
ALTER TABLE "payment_intents" ADD COLUMN "claimId" CHAR(66);

CREATE UNIQUE INDEX "payment_intents_claimId_key" ON "payment_intents"("claimId");
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
