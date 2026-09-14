ALTER TABLE "claims"
ADD COLUMN "encryptedRecipientEmail" BYTEA NOT NULL,
ADD COLUMN "encryptedInviteToken" BYTEA NOT NULL,
ADD COLUMN "preparedAtBlock" BIGINT NOT NULL,
ADD COLUMN "preparationExpiresAt" TIMESTAMPTZ(6) NOT NULL;
