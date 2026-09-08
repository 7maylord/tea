-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "privyDid" VARCHAR(128) NOT NULL,
    "displayName" VARCHAR(100),
    "handle" VARCHAR(20),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "users_handle_format" CHECK ("handle" IS NULL OR ("handle" ~ '^[a-z0-9_]{3,20}$' AND "handle" NOT IN ('tea', 'admin', 'support')))
);

-- CreateTable
CREATE TABLE "identities" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL DEFAULT 'email',
    "encryptedValue" BYTEA NOT NULL,
    "lookupKey" CHAR(64) NOT NULL,
    "normalizationVersion" INTEGER NOT NULL DEFAULT 1,
    "verifiedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "accountType" VARCHAR(32) NOT NULL DEFAULT 'privy_embedded',
    "settlementAddress" VARCHAR(42) NOT NULL,
    "signerReference" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounts_chain_id_positive" CHECK ("chainId" > 0),
    CONSTRAINT "accounts_settlement_address_format" CHECK ("settlementAddress" ~ '^0x[0-9a-f]{40}$')
);

-- CreateIndex
CREATE UNIQUE INDEX "users_privyDid_key" ON "users"("privyDid");

-- CreateIndex
CREATE UNIQUE INDEX "users_handle_key" ON "users"("handle");

-- CreateIndex
CREATE INDEX "identities_userId_idx" ON "identities"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "identities_kind_lookupKey_key" ON "identities"("kind", "lookupKey");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_userId_chainId_key" ON "accounts"("userId", "chainId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_chainId_settlementAddress_key" ON "accounts"("chainId", "settlementAddress");

-- AddForeignKey
ALTER TABLE "identities" ADD CONSTRAINT "identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
