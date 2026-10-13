ALTER TABLE "payment_intents" ADD COLUMN "recipientNotifiedAt" TIMESTAMPTZ(6);
ALTER TABLE "split_obligations" ADD COLUMN "notifiedAt" TIMESTAMPTZ(6);

UPDATE "payment_intents"
SET "recipientNotifiedAt" = "createdAt"
WHERE "kind" IN ('STREAM', 'DATE_LOCK') AND "state" = 'CONFIRMED';

UPDATE "split_obligations" SET "notifiedAt" = "createdAt";
