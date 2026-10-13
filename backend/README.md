# TEA backend

The NestJS backend authenticates Privy sessions, binds Mera payment accounts, resolves handles and verified email recipients, prepares transaction plans, verifies Monad receipts, records private activity, sends transactional email, and runs the TUSD/AUSD test faucet.

Production API: <https://usetea.up.railway.app/>

## Local setup

Start the repository's Postgres and Redis services first:

```sh
./scripts/docker-local.sh up -d --wait
```

Then configure and start the API:

```sh
cd backend
cp .env.example .env
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm start:dev
```

The API listens on `http://127.0.0.1:3001`. Check it with:

```sh
curl http://127.0.0.1:3001/health/live
```

## Required configuration

Use `backend/.env` locally and Railway variables in production. The complete template is `.env.example`; the main groups are:

- application origins: `APP_ORIGIN`, `API_ORIGIN`
- Monad: `CHAIN_ID`, `RPC_URL`, `SETTLEMENT_TOKEN`, `SETTLEMENT_TOKENS`
- deployed contracts: `CLAIM_ESCROW_ADDRESS`, `TEA_STREAM_ADDRESS`, `TEA_DATE_UNLOCK_ADDRESS`
- Agora faucet: `AUSD_TOKEN`, `AUSD_FAUCET_ADDRESS`
- storage: `DATABASE_URL`, `REDIS_URL`
- authentication: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`
- protected identity data: `IDENTITY_LOOKUP_HMAC_KEY`, `IDENTITY_ENCRYPTION_KEY`
- transaction services: `CLAIM_IDENTITY_SIGNER_PRIVATE_KEY`, `RELAYER_PRIVATE_KEY`, `FAUCET_PRIVATE_KEY`
- email: `EMAIL_PROVIDER_KEY`, `EMAIL_FROM`, and optional `EMAIL_REPLY_TO`

`SETTLEMENT_TOKENS` is a comma-separated list of token addresses. It currently contains TUSD and Agora AUSD. Token symbols and decimals are read from the chain; the server rejects requests for addresses outside this list.

The production image runs `prisma migrate deploy` before starting the API, so `DATABASE_URL` must point to a reachable Postgres database. `REDIS_URL` is required for recipient references, rate limits, and job coordination.

## API groups

- `/v1/session` and `/v1/me` — session synchronization, Mera account binding, and handles
- `/v1/resolve` — private handle/email recipient resolution
- `/v1/balances` — balances for every configured settlement token
- `/v1/payments` — direct ERC-20 payment intents and receipt verification
- `/v1/claims` — email escrow deposit, invitation, claim, resend, and refund flows
- `/v1/streams` — funded stream creation, withdrawal, and cancellation
- `/v1/date-locks` — funded date-lock creation and withdrawal
- `/v1/splits` — offchain split requests settled with direct ERC-20 payments
- `/v1/faucet` — daily token and MON testnet funding
- `/v1/activity` and `/v1/threads` — private application activity

Money-changing operations require a Privy token and an `Idempotency-Key`. The backend returns exact calldata plans, and the frontend checks the chain, contract, token, recipient, and amount before Mera signs. A payment is recorded as confirmed only after its receipt and emitted events match the stored intent.

Email notifications are sent immediately after confirmed email claims, streams, date locks, and split requests. Delivery uses Resend through `EMAIL_PROVIDER_KEY` and a verified `EMAIL_FROM` domain.

## Checks

```sh
pnpm lint:check
pnpm exec prisma validate
pnpm build
pnpm test
pnpm test:db
pnpm test:e2e
pnpm test:resolve
pnpm check:network
pnpm check:claims
```

Database and integration checks require the local Postgres and Redis containers. Network and claim checks read the deployed Monad contracts configured in `.env`.
