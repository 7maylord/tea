# TEA deployment

TEA has two required deployable app parts and one optional bounty artifact:

1. `backend/` — Nest API, Prisma migrations, claim workers and private activity.
2. `frontend/` — Next PWA. `NEXT_PUBLIC_*` values are build-time inputs.
3. `indexer/` — optional Envio HyperIndex deployment for Metropolis judging/bounty evidence.

## Backend

Set production env vars on the host or in `backend/.env.production`:

- `APP_ENV=production`
- `PORT=3001`
- `APP_ORIGIN=https://<frontend-host>`
- `API_ORIGIN=https://<backend-host>`
- `DATABASE_URL`
- `REDIS_URL`
- `CHAIN_ID=10143`
- `RPC_URL`
- `SETTLEMENT_TOKEN`
- `CLAIM_ESCROW_ADDRESS`
- `TEA_STREAM_ADDRESS`
- `TEA_DATE_UNLOCK_ADDRESS`
- `PRIVY_APP_ID`
- `PRIVY_APP_SECRET`
- `IDENTITY_LOOKUP_HMAC_KEY`
- `IDENTITY_ENCRYPTION_KEY`
- `CLAIM_IDENTITY_SIGNER_PRIVATE_KEY`
- `RELAYER_PRIVATE_KEY`
- `EMAIL_PROVIDER_KEY`
- `EMAIL_FROM`

The backend image runs `pnpm db:migrate` before `node dist/main.js`. On Railway, create a Postgres service, then set the backend service variable `DATABASE_URL` as a reference to the database service value, for example `${{Postgres.DATABASE_URL}}` if the service is named `Postgres`. Delete any manually created blank `DATABASE_URL`; Prisma treats an empty string as invalid. Add Redis the same way for `REDIS_URL`. Health checks:

```sh
curl https://<backend-host>/health/live
```

## Frontend

Set these at build time:

- `NEXT_PUBLIC_PRIVY_APP_ID`
- `NEXT_PUBLIC_API_ORIGIN=https://<backend-host>`
- `NEXT_PUBLIC_CHAIN_ID=10143`
- `NEXT_PUBLIC_SETTLEMENT_TOKEN`
- `NEXT_PUBLIC_CLAIM_ESCROW_ADDRESS`
- `NEXT_PUBLIC_TEA_STREAM_ADDRESS`
- `NEXT_PUBLIC_TEA_DATE_UNLOCK_ADDRESS`

## Optional Envio deployment

The backend does not require `ENVIO_GRAPHQL_URL` or an Envio API URL. It confirms submitted transactions directly from Monad RPC and stores private activity in Postgres.

Keep `indexer/` deployable for the Metropolis Envio bounty. The Metropolis note says development-plan indexers are automatically deprecated once they are more than 30 days old; for judging, create a fresh Envio Cloud deployment on or after September 27. Use the pinned Monad testnet config in `indexer/config.yaml`.

## Single-host Docker compose

For a single VM or container host:

```sh
cp backend/.env.example backend/.env.production
# fill backend/.env.production without committing it
POSTGRES_PASSWORD='<strong-db-password>' \
NEXT_PUBLIC_PRIVY_APP_ID='<privy-app-id>' \
NEXT_PUBLIC_API_ORIGIN='https://<backend-host>' \
docker compose -f infrastructure/compose.prod.yaml up -d --build
```

Use a managed Postgres/Redis and platform env vars instead of the compose `postgres` and `redis` services when deploying to Render, Fly, Railway or similar.
