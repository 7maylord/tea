ALTER TABLE "faucet_claims" ADD COLUMN "tokenAddress" VARCHAR(42);
UPDATE "faucet_claims"
SET "tokenAddress" = '0x82ce012544f85e33930c5272bdeae76736a8f22b'
WHERE "tokenAddress" IS NULL;
ALTER TABLE "faucet_claims" ALTER COLUMN "tokenAddress" SET NOT NULL;
DROP INDEX "faucet_claims_chainId_walletAddress_claimDay_key";
CREATE UNIQUE INDEX "faucet_claims_chainId_tokenAddress_walletAddress_claimDay_key"
ON "faucet_claims"("chainId", "tokenAddress", "walletAddress", "claimDay");
