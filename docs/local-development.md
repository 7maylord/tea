# Development stack

Run Postgres and Redis in Docker:

```sh
docker compose -f infrastructure/compose.yaml up -d --wait
```

Use the deployed Monad testnet contracts for settlement checks. Local contract deployment is no longer part of the app flow.

Connection values:

```text
DATABASE_URL=postgresql://tea:tea_local_only@127.0.0.1:55432/tea
REDIS_URL=redis://127.0.0.1:6380
RPC_URL=https://testnet-rpc.monad.xyz
CHAIN_ID=10143
```

The backend's `.env.example` lists the remaining configuration placeholders. Install each app in its own folder. Before starting the backend against a fresh database, generate its Prisma client and apply migrations:

```sh
cd backend
pnpm install
DATABASE_URL=postgresql://tea:tea_local_only@127.0.0.1:55432/tea pnpm db:generate
DATABASE_URL=postgresql://tea:tea_local_only@127.0.0.1:55432/tea pnpm db:migrate
DATABASE_URL=postgresql://tea:tea_local_only@127.0.0.1:55432/tea pnpm test:db
```

Before using the app, run `pnpm check:network` from `backend/` with `RPC_URL`, `CHAIN_ID`, `SETTLEMENT_TOKEN`, `SETTLEMENT_TOKEN_DECIMALS`, `TEA_STREAM_ADDRESS`, `CLAIM_ESCROW_ADDRESS` and `TEA_DATE_UNLOCK_ADDRESS` set. It reads the Monad chain ID, token metadata/code, and each deployed app contract at one block, then fails on a missing contract or mismatch. Then run `pnpm check:claims`; it verifies `CLAIM_IDENTITY_SIGNER_PRIVATE_KEY` matches the escrow identity signer and `RELAYER_PRIVATE_KEY` has native gas. Compare the reported token address and code hash with an issuer or network source yourself; token metadata alone does not establish provenance.

For identity sync, set `PRIVY_APP_ID` and `PRIVY_APP_SECRET`, and generate **two separate** 32-byte base64 secrets with `openssl rand -base64 32`. Set those as `IDENTITY_LOOKUP_HMAC_KEY` and `IDENTITY_ENCRYPTION_KEY`. `POST /v1/session/sync` accepts the Privy access token in the `privy-id-token` header. It verifies the token, fetches current linked accounts from Privy, and refuses an unverified email or missing embedded EVM wallet. With Docker Postgres running, run `pnpm test:identity` from `backend/` with the local `DATABASE_URL` above; this exercises HTTP and database behavior using mocked Privy data. A live Privy test remains part of Gate A.

The backend does not use `BUNDLER_URL`, `PAYMASTER_URL`, `CLAIM_IDENTITY_SIGNER_REF` or `RELAYER_SIGNER_REF`. Privy's planned app-pays flow is configured in its dashboard, without separate bundler or paymaster URLs. Claim authorizations use a dedicated `CLAIM_IDENTITY_SIGNER_PRIVATE_KEY` injected into the backend process; it must match the escrow's configured signer. Claim relay and automatic refunds use a separate `RELAYER_PRIVATE_KEY`. Keep both outside Git and use dedicated test-funds keys. `EMAIL_PROVIDER_KEY` is a [Resend API key](https://resend.com/docs/api-reference/api-keys/create-api-key); `EMAIL_FROM` is an address on a [verified sending domain](https://resend.com/docs/dashboard/domains/introduction). The backend never exposes these values to the frontend.

`POST /v1/me/handle` reserves one immutable handle. `POST /v1/resolve` accepts `{ "kind": "handle" | "email", "value": "..." }` with the same session-token header and requires `REDIS_URL`. It returns an expiring recipient reference for a current verified account, or `unregistered` for an email with no verified TEA account. Run `pnpm test:resolve` from `backend/` with both local `DATABASE_URL` and `REDIS_URL` set to exercise its Postgres and Redis behavior. Payment-intent consumption of the reference is a later checkpoint.

Create `backend/.env` once from `backend/.env.example`, then fill in the Privy credentials, secrets and deployed addresses. Run the backend from the repository root; Nest does not load that file automatically:

```sh
cd backend
set -a; . ./.env; set +a
pnpm run start:dev
```

Run the frontend in another terminal, also from the repository root:

```sh
cd frontend
pnpm install
pnpm run dev
```

Set `NEXT_PUBLIC_PRIVY_APP_ID` and `NEXT_PUBLIC_API_ORIGIN` in `frontend/.env` (copy `frontend/.env.example` first). The Privy app ID is public; keep `PRIVY_APP_SECRET` only in the backend environment. The API allows the origin in `APP_ORIGIN` for browser requests. Open the frontend at that exact origin, such as `http://127.0.0.1:3000` for the local example.
Set `NEXT_PUBLIC_CHAIN_ID=10143` for Monad testnet. The mobile Send screen resolves an exact TEA name, reviews an integer token amount, validates the backend's transfer plan, and submits it through Privy's embedded wallet. The screen retains a submitted hash and idempotency key for status recovery after refresh. If the wallet returns no hash after an uncertain submission, inspect wallet activity before attempting another transfer.

The API defaults to port 3001 and Next.js to port 3000.
`GET http://127.0.0.1:3001/health/live` checks that the API process is serving requests; it does not test database or queue readiness.

`POST /v1/payments` accepts `Idempotency-Key` plus `{ "recipientReference": "...", "amountUnits": "..." }` after exact recipient lookup. It stores one immutable direct-send intent and returns an ERC-20 transfer plan; it does **not** submit a transaction. `GET /v1/payments/:id` lets the payer recover that plan while its authorization window is open. After the wallet broadcasts a transfer, `POST /v1/payments/:id/submission` accepts `Idempotency-Key` and `{ "txHash": "0x..." }`. It verifies the sender, token, calldata, value, preparation block and ERC-20 transfer log before marking the intent confirmed. A hash the RPC cannot find is stored as `RECONCILING` and remains reserved; `GET /v1/payments/:id` checks it again. The backend verifies the submitted deployed-network transaction by sender, token, calldata, value, preparation block and transfer log before confirming it.

`POST /v1/claims` accepts `Idempotency-Key` plus `{ "recipientEmail": "...", "amountUnits": "..." }`. It stores a salted identity commitment and encrypted invite data, then returns exact token approval and escrow deposit plans for the payer's wallet. `POST /v1/claims/:id/deposit` accepts a deposit transaction hash and confirms the exact call, escrow event and token transfer before opening the claim; an approval receipt cannot open it. Once open, the outbox worker may email the opaque link. Start it after `pnpm build` with `pnpm start:claim-worker`; email needs `EMAIL_PROVIDER_KEY`, `EMAIL_FROM`, and a frontend `APP_ORIGIN` reachable by the recipient. The payer may call `POST /v1/claims/:id/resend` with an idempotency key after the first invite succeeds; it queues at most one resend per minute and five per 24 hours to the stored encrypted email. `POST /v1/claims/resolve-link` reveals details only to a Privy session with the matching verified email. `POST /v1/claims/:id/authorize` takes `{ "inviteToken": "..." }` plus an idempotency key and issues a five-minute EIP-712 authorization for that session's settlement wallet. The recipient signs its `acceptanceTypedData`, then calls `POST /v1/claims/:id/submit` with `{ "inviteToken": "...", "authorizationDigest": "0x...", "recipientSignature": "0x..." }` and an idempotency key. The worker verifies and relays the exact proofs with `RELAYER_PRIVATE_KEY`. At expiry, the same worker refunds the stored payer; `POST /v1/claims/:id/refund` lets the payer queue an eligible refund immediately.
The Send screen treats an unregistered exact email as a claim payment. It shows the full email, amount, 14-day lock and refund terms, validates exact approval/deposit calldata, and persists transaction hashes so approval and deposit can resume separately. The emailed `/claim/<token>` page shows no amount until Privy verifies the invited email. It validates the returned chain and escrow before asking the recipient wallet to sign an EIP-712 acceptance, submits the proof, and polls the onchain claim state. The route disables referrers and caching.

`POST /v1/streams` accepts `Idempotency-Key` plus `{ "recipientReference": "...", "amountUnits": "...", "durationSeconds": "..." }`. It reserves the full amount and returns exact token approval and `TeaStream.create` plans. `POST /v1/streams/:id/submission` accepts the create transaction hash; it verifies the signed call, stream creation event and token transfer before confirming and recording the onchain stream ID. An approval alone cannot confirm a stream. `GET /v1/streams/:id` reconciles that transaction and reads current contract state for the payer, or for the recipient after confirmation. `POST /v1/streams/:id/withdraw` and `POST /v1/streams/:id/cancel` persist idempotent action plans for the original rights holder. `POST /v1/streams/:id/actions/:actionId/submission` registers and independently verifies the exact transaction, lifecycle event and token movement; `GET` on the same action path recovers its state. Envio indexes creation, collection and cancellation events; the backend attaches the canonical creation receipt to private activity.

`POST /v1/date-locks` accepts `Idempotency-Key` plus `{ "recipientReference": "...", "amountUnits": "...", "unlockAt": "<ISO timestamp>" }`. It reserves the full amount and returns exact token approval and `TeaDateUnlock.create` plans. `POST /v1/date-locks/:id/submission` accepts the create transaction hash and verifies the signed call, lock-created event and token transfer. An approval alone cannot confirm a lock. `GET /v1/date-locks/:id` reconciles creation and reads current lock state for the payer, or for the recipient after confirmation. `POST /v1/date-locks/:id/withdraw` creates an idempotent recipient-only collection plan after unlock; `POST /v1/date-locks/:id/actions/:actionId/submission` verifies the exact withdrawal event and token movement.
Choose **Over time** in the Send screen for an existing TEA member. The client validates exact approval and creation calldata, persists both transaction stages, and confirms the funded stream through the backend. Confirmed stream cards use the latest chain timestamp plus monotonic elapsed time for their accrual estimate. The original recipient can collect available funds; the sender can stop future accrual. Each action plan is checked against the stream contract and onchain stream ID before signing.

Envio will be connected to the deployed Monad contracts in checkpoint 7. `GET /v1/activity` includes an `indexedReceipt` only when Envio's event matches the confirmed intent and its canonical block hash. A confirmed payment without an indexed receipt remains confirmed while activity catches up.

`GET /v1/activity` also returns a payer's open or refunded email claims, including the claim ID needed for resend and refund actions. `GET /v1/threads` lists one thread per pair of users and chain, with a cursor for the next page. `GET /v1/threads/:id` returns that thread's authorized payment activity and indexed receipts. The payer sees their pending attempts; the recipient sees only confirmed payments. Other users receive 404. Direct payments, claimed email payments and streams between the same two users share a thread after the recipient claims.

Stop services with `docker compose -f infrastructure/compose.yaml down`. Add `-v` only when you intend to delete the local database and queue state.

Once the app flows are implemented, run two-user send, claim/refund, stream and date-lock journeys against Monad testnet, including a backend/worker restart and a repeated submission.
