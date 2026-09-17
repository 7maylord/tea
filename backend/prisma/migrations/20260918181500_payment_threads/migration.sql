CREATE TABLE "threads" (
  "id" UUID NOT NULL,
  "chainId" INTEGER NOT NULL,
  "lowerUserId" UUID NOT NULL,
  "upperUserId" UUID NOT NULL,
  "lastActivityAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "threads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "threads_chainId_lowerUserId_upperUserId_key" ON "threads"("chainId", "lowerUserId", "upperUserId");
CREATE INDEX "threads_lastActivityAt_id_idx" ON "threads"("lastActivityAt", "id");
ALTER TABLE "threads" ADD CONSTRAINT "threads_lowerUserId_fkey" FOREIGN KEY ("lowerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "threads" ADD CONSTRAINT "threads_upperUserId_fkey" FOREIGN KEY ("upperUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_intents" ADD COLUMN "threadId" UUID;

INSERT INTO "threads" ("id", "chainId", "lowerUserId", "upperUserId", "lastActivityAt")
SELECT gen_random_uuid(), "chainId", LEAST("payerId", "recipientUserId"), GREATEST("payerId", "recipientUserId"), MAX("createdAt")
FROM "payment_intents"
WHERE "recipientUserId" IS NOT NULL AND "payerId" <> "recipientUserId"
GROUP BY "chainId", LEAST("payerId", "recipientUserId"), GREATEST("payerId", "recipientUserId");

UPDATE "payment_intents" p
SET "threadId" = t."id"
FROM "threads" t
WHERE p."chainId" = t."chainId"
  AND LEAST(p."payerId", p."recipientUserId") = t."lowerUserId"
  AND GREATEST(p."payerId", p."recipientUserId") = t."upperUserId";

CREATE INDEX "payment_intents_threadId_createdAt_id_idx" ON "payment_intents"("threadId", "createdAt", "id");
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
