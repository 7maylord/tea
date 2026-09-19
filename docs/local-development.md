# Local end-to-end stack

Run Postgres and Redis in Docker:

```sh
docker compose -f infrastructure/compose.yaml up -d --wait
```

Run Anvil in another terminal:

```sh
anvil --host 127.0.0.1 --port 8545 --chain-id 31337
```

Deploy the local-only faucet token, stream and claim escrow from `contracts/` using an unlocked Anvil account:

```sh
ANVIL_SENDER=$(cast rpc eth_accounts --rpc-url http://127.0.0.1:8545 | jq -r '.[0]')
forge script script/LocalDeploy.s.sol:LocalDeployScript --rpc-url http://127.0.0.1:8545 --sender "$ANVIL_SENDER" --unlocked --broadcast
```

The script prints the token, stream and escrow addresses. Use its faucet only on Anvil; the token rejects deployment on any other chain ID.
Set `SETTLEMENT_TOKEN` in `backend/.env` to the printed token address. Set `TEA_STREAM_ADDRESS` to the printed stream address for later stream checks.
Set `CLAIM_ESCROW_ADDRESS` to the printed escrow address. The local escrow's identity signer is Anvil account 0; set `CLAIM_IDENTITY_SIGNER_PRIVATE_KEY` to that **Anvil-only** test account's key for claim integration tests. Set `RELAYER_PRIVATE_KEY` to a separate Anvil account key for automatic refunds. Never use Anvil keys with real funds.

Run the chain lifecycle check with those addresses:

```sh
TEA_TOKEN_ADDRESS=<token-address> TEA_STREAM_ADDRESS=<stream-address> bash contracts/script/smoke-anvil.sh
```

Local connection values:

```text
DATABASE_URL=postgresql://tea:tea_local_only@127.0.0.1:55432/tea
REDIS_URL=redis://127.0.0.1:6380
RPC_URL=http://127.0.0.1:8545
CHAIN_ID=31337
```

The backend's `.env.example` lists the remaining configuration placeholders. Install each app in its own folder. Before starting the backend against a fresh database, generate its Prisma client and apply migrations:

```sh
cd backend
pnpm install
DATABASE_URL=postgresql://tea:tea_local_only@127.0.0.1:55432/tea pnpm db:generate
DATABASE_URL=postgresql://tea:tea_local_only@127.0.0.1:55432/tea pnpm db:migrate
DATABASE_URL=postgresql://tea:tea_local_only@127.0.0.1:55432/tea pnpm test:db
```

Before using any settlement network, run `pnpm check:network` from `backend/` with `RPC_URL`, `CHAIN_ID`, `SETTLEMENT_TOKEN` and `SETTLEMENT_TOKEN_DECIMALS` set. It reads the chain ID, token bytecode hash, metadata and decimals at one block and fails on a missing contract or mismatch. Compare the reported token address and code hash with an issuer or network source yourself; token metadata alone does not establish provenance. On Anvil, the expected chain ID is 31337 and the local mock token has six decimals.

For identity sync, enable identity tokens in the Privy app, set `PRIVY_APP_ID` and `PRIVY_APP_SECRET`, and generate **two separate** 32-byte base64 secrets with `openssl rand -base64 32`. Set those as `IDENTITY_LOOKUP_HMAC_KEY` and `IDENTITY_ENCRYPTION_KEY`. `POST /v1/session/sync` accepts the Privy identity token in the `privy-id-token` header. It verifies the token, fetches current linked accounts from Privy, and refuses an unverified email or missing embedded EVM wallet. With Docker Postgres running, run `pnpm test:identity` from `backend/` with the local `DATABASE_URL` above; this exercises HTTP and database behavior using mocked Privy data. A live Privy test remains part of Gate A.

The backend does not use `BUNDLER_URL`, `PAYMASTER_URL`, `CLAIM_IDENTITY_SIGNER_REF` or `RELAYER_SIGNER_REF`. Privy's planned app-pays flow is configured in its dashboard, without separate bundler or paymaster URLs. Claim authorizations use a dedicated `CLAIM_IDENTITY_SIGNER_PRIVATE_KEY` injected into the backend process; it must match the escrow's configured signer. Claim relay and automatic refunds use a separate `RELAYER_PRIVATE_KEY`. Keep both outside Git and use dedicated test-funds keys. `EMAIL_PROVIDER_KEY` is a [Resend API key](https://resend.com/docs/api-reference/api-keys/create-api-key); `EMAIL_FROM` is an address on a [verified sending domain](https://resend.com/docs/dashboard/domains/introduction). The backend never exposes these values to the frontend.

`POST /v1/me/handle` reserves one immutable handle. `POST /v1/resolve` accepts `{ "kind": "handle" | "email", "value": "..." }` with the same identity-token header and requires `REDIS_URL`. It returns an expiring recipient reference for a current verified account, or `unregistered` for an email with no verified TEA account. Run `pnpm test:resolve` from `backend/` with both local `DATABASE_URL` and `REDIS_URL` set to exercise its Postgres and Redis behavior. Payment-intent consumption of the reference is a later checkpoint.

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
Set `NEXT_PUBLIC_CHAIN_ID=31337` for Anvil. The mobile Send screen resolves an exact TEA name, reviews an integer token amount, validates the backend's transfer plan, and submits it through Privy's embedded wallet. On Anvil it uses the local gas supplied by the test faucet; target-network sponsorship remains unverified. The screen retains a submitted hash and idempotency key for status recovery after refresh. If the wallet returns no hash after an uncertain submission, inspect wallet activity before attempting another transfer.

The API defaults to port 3001 and Next.js to port 3000.
`GET http://127.0.0.1:3001/health/live` checks that the API process is serving requests; it does not test database or queue readiness.

After onboarding and claiming a handle, Home reads the token balance at a specific Anvil block. **Get 20 test USD** submits a local mint to the signed-in wallet and tops up its Anvil gas balance when low; refresh the token balance to see the mint after confirmation. The API ignores client-supplied recipients and amounts. The faucet is available only with `APP_ENV=local`, chain ID 31337, a loopback Anvil RPC and the local-only token. From `backend/`, run `RPC_URL=http://127.0.0.1:8545 SETTLEMENT_TOKEN=<token-address> pnpm test:funds` to check a real mint and gas transfer; this test substitutes a verified session because live Privy credentials are still required for browser onboarding.

`POST /v1/payments` accepts `Idempotency-Key` plus `{ "recipientReference": "...", "amountUnits": "..." }` after exact recipient lookup. It stores one immutable direct-send intent and returns an ERC-20 transfer plan; it does **not** submit a transaction. `GET /v1/payments/:id` lets the payer recover that plan while its authorization window is open. From `backend/`, run `DATABASE_URL=postgresql://tea:tea_local_only@127.0.0.1:55432/tea RPC_URL=http://127.0.0.1:8545 SETTLEMENT_TOKEN=<token-address> pnpm test:payments` to check idempotency and reservations against Postgres and Anvil. The test substitutes verified sessions; live authorization, sponsorship and target-network verification remain open.
After the wallet broadcasts a transfer, `POST /v1/payments/:id/submission` accepts `Idempotency-Key` and `{ "txHash": "0x..." }`. It verifies the sender, token, calldata, value, preparation block and ERC-20 transfer log before marking the intent confirmed. A hash the RPC cannot find is stored as `RECONCILING` and remains reserved; `GET /v1/payments/:id` checks it again. The local test covers an actual Anvil transfer, an older matching transfer, a wrong transaction, an unknown hash and a retry. Target-network signing and sponsorship remain unverified.

`POST /v1/claims` accepts `Idempotency-Key` plus `{ "recipientEmail": "...", "amountUnits": "..." }`. It stores a salted identity commitment and encrypted invite data, then returns exact token approval and escrow deposit plans for the payer's wallet. `POST /v1/claims/:id/deposit` accepts a deposit transaction hash and confirms the exact call, escrow event and token transfer before opening the claim; an approval receipt cannot open it. Once open, the outbox worker may email the opaque link. Start it after `pnpm build` with `pnpm start:claim-worker`; email needs `EMAIL_PROVIDER_KEY`, `EMAIL_FROM`, and a frontend `APP_ORIGIN` reachable by the recipient. `POST /v1/claims/resolve-link` reveals details only to a Privy session with the matching verified email. `POST /v1/claims/:id/authorize` takes `{ "inviteToken": "..." }` plus an idempotency key and issues a five-minute EIP-712 authorization for that session's settlement wallet. The recipient signs its `acceptanceTypedData`, then calls `POST /v1/claims/:id/submit` with `{ "inviteToken": "...", "authorizationDigest": "0x...", "recipientSignature": "0x..." }` and an idempotency key. The worker verifies and relays the exact proofs with `RELAYER_PRIVATE_KEY`. At expiry, the same worker refunds the stored payer; `POST /v1/claims/:id/refund` lets the payer queue an eligible refund immediately. From `backend/`, run `pnpm test:claims` with local `DATABASE_URL`, `RPC_URL`, `SETTLEMENT_TOKEN`, `CLAIM_ESCROW_ADDRESS`, identity keys and the local signer/relayer keys; it exercises deposits, private links, signature-gated relay, mocked email and automatic refunds on Anvil.
The Send screen treats an unregistered exact email as a claim payment. It shows the full email, amount, 14-day lock and refund terms, validates exact approval/deposit calldata, and persists transaction hashes so approval and deposit can resume separately. The emailed `/claim/<token>` page shows no amount until Privy verifies the invited email. It validates the returned chain and escrow before asking the recipient wallet to sign an EIP-712 acceptance, submits the proof, and polls the onchain claim state. The route disables referrers and caching.

`POST /v1/streams` accepts `Idempotency-Key` plus `{ "recipientReference": "...", "amountUnits": "...", "durationSeconds": "..." }`. It reserves the full amount and returns exact token approval and `TeaStream.create` plans. `POST /v1/streams/:id/submission` accepts the create transaction hash; it verifies the signed call, stream creation event and token transfer before confirming and recording the onchain stream ID. An approval alone cannot confirm a stream. `GET /v1/streams/:id` reconciles that transaction and reads current contract state for the payer, or for the recipient after confirmation. `POST /v1/streams/:id/withdraw` prepares an exact Collect call for the original recipient wallet when funds are available; `POST /v1/streams/:id/cancel` prepares an exact Cancel call for the original sender wallet before the stream ends. Both require an identity token and `Idempotency-Key`; the wallet signs and broadcasts each call. Run `pnpm test:streams` with local `DATABASE_URL`, `RPC_URL`, `SETTLEMENT_TOKEN` and `TEA_STREAM_ADDRESS` against Anvil. The test verifies create, partial collection, cancellation, final collection, rights and conservation. Indexed stream receipts remain the next checkpoint.

Start Envio separately from `indexer/` with `ENVIO_TUI=false ENVIO_PG_PORT=55433 pnpm dev` and the local Anvil contracts configured as in `indexer/.env.example`. Its GraphQL endpoint is `http://127.0.0.1:8080/v1/graphql`. Set `ENVIO_GRAPHQL_URL` to that URL and `ENVIO_ADMIN_SECRET=testing` in the local backend environment. `GET /v1/activity` includes an `indexedReceipt` only when Envio's event matches the confirmed intent and its canonical block hash. A confirmed payment without an indexed receipt remains confirmed while activity catches up. Run `pnpm test:payments` with those Envio variables to verify this path against Anvil and the live indexer.

`GET /v1/threads` lists one thread per pair of users and chain, with a cursor for the next page. `GET /v1/threads/:id` returns that thread's authorized payment activity and indexed receipts. The payer sees their pending attempts; the recipient sees only confirmed payments. Other users receive 404. Direct payments and streams between the same two users share a thread.

These credentials and Anvil accounts are for local tests only. Stop services with `docker compose -f infrastructure/compose.yaml down`. Add `-v` only when you intend to delete the local database and queue state.

Once the app flows are implemented, run two-user send, claim/refund and stream journeys against this stack, including a backend/worker restart and a repeated submission. The local run proves app behavior; the target-network sponsorship and deployment gates in the implementation plan remain separate.
