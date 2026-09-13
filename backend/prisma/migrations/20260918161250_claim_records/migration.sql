CREATE TABLE "claims" (
    "id" CHAR(66) NOT NULL,
    "payerId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "escrowAddress" VARCHAR(42) NOT NULL,
    "tokenAddress" VARCHAR(42) NOT NULL,
    "payerAddress" VARCHAR(42) NOT NULL,
    "amountUnits" DECIMAL(78,0) NOT NULL,
    "identityLookupKey" CHAR(64) NOT NULL,
    "identityCommitment" CHAR(66) NOT NULL,
    "encryptedBindingSecret" BYTEA NOT NULL,
    "inviteTokenHash" CHAR(64) NOT NULL,
    "expiry" TIMESTAMPTZ(6),
    "state" VARCHAR(32) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "depositTxHash" VARCHAR(66),
    "depositBlockNumber" BIGINT,
    "depositBlockHash" VARCHAR(66),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "claims_inviteTokenHash_key" ON "claims"("inviteTokenHash");
CREATE UNIQUE INDEX "claims_payerId_idempotencyKey_key" ON "claims"("payerId", "idempotencyKey");
CREATE UNIQUE INDEX "claims_chainId_escrowAddress_depositTxHash_key" ON "claims"("chainId", "escrowAddress", "depositTxHash");
CREATE INDEX "claims_state_expiry_idx" ON "claims"("state", "expiry");
ALTER TABLE "claims" ADD CONSTRAINT "claims_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "claim_authorizations" (
    "id" UUID NOT NULL,
    "claimId" CHAR(66) NOT NULL,
    "nonce" DECIMAL(78,0) NOT NULL,
    "recipientAddress" VARCHAR(42) NOT NULL,
    "deadline" TIMESTAMPTZ(6) NOT NULL,
    "signerEpoch" BIGINT NOT NULL,
    "digest" CHAR(66) NOT NULL,
    "state" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "claim_authorizations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "claim_authorizations_claimId_state_idx" ON "claim_authorizations"("claimId", "state");
ALTER TABLE "claim_authorizations" ADD CONSTRAINT "claim_authorizations_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
