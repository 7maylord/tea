ALTER TABLE "payment_intents"
  ADD COLUMN "streamAddress" VARCHAR(42),
  ADD COLUMN "durationSeconds" BIGINT,
  ADD COLUMN "streamId" DECIMAL(78, 0);
