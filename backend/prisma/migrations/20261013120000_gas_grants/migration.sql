CREATE TABLE "gas_grants" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "walletAddress" VARCHAR(42) NOT NULL,
    "grantDay" DATE NOT NULL,
    "amountWei" DECIMAL(78,0) NOT NULL,
    "state" VARCHAR(16) NOT NULL,
    "txHash" VARCHAR(66),
    "blockNumber" BIGINT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gas_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gas_grants_chainId_walletAddress_grantDay_key"
ON "gas_grants"("chainId", "walletAddress", "grantDay");

CREATE INDEX "gas_grants_userId_createdAt_idx" ON "gas_grants"("userId", "createdAt");

ALTER TABLE "gas_grants"
ADD CONSTRAINT "gas_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
