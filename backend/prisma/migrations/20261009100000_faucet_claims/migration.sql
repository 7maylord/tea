CREATE TABLE "faucet_claims" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "chainId" INTEGER NOT NULL,
  "walletAddress" VARCHAR(42) NOT NULL,
  "claimDay" DATE NOT NULL,
  "amountUnits" DECIMAL(78,0) NOT NULL,
  "state" VARCHAR(16) NOT NULL,
  "txHash" VARCHAR(66),
  "blockNumber" BIGINT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "faucet_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "faucet_claims_chainId_walletAddress_claimDay_key" ON "faucet_claims"("chainId", "walletAddress", "claimDay");
CREATE INDEX "faucet_claims_userId_createdAt_idx" ON "faucet_claims"("userId", "createdAt");
ALTER TABLE "faucet_claims" ADD CONSTRAINT "faucet_claims_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
