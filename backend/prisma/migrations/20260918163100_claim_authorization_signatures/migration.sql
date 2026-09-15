ALTER TABLE "claim_authorizations"
ADD COLUMN "identitySignature" BYTEA NOT NULL,
ADD COLUMN "idempotencyKey" VARCHAR(128) NOT NULL,
ADD COLUMN "requestHash" CHAR(64) NOT NULL;

CREATE UNIQUE INDEX "claim_authorizations_claimId_idempotencyKey_key" ON "claim_authorizations"("claimId", "idempotencyKey");
