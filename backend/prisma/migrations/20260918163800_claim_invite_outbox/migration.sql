CREATE TABLE "outbox_jobs" (
    "id" UUID NOT NULL,
    "claimId" CHAR(66) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "dedupeKey" VARCHAR(128) NOT NULL,
    "state" VARCHAR(16) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "outbox_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outbox_jobs_dedupeKey_key" ON "outbox_jobs"("dedupeKey");
CREATE INDEX "outbox_jobs_state_nextAttemptAt_idx" ON "outbox_jobs"("state", "nextAttemptAt");
ALTER TABLE "outbox_jobs" ADD CONSTRAINT "outbox_jobs_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
