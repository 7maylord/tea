# TEA deployment

TEA has three deployable parts:

1. `backend/` — Nest API, Prisma migrations, claim workers and private activity.
2. `frontend/` — Next PWA. `NEXT_PUBLIC_*` values are build-time inputs.
3. `indexer/` — Envio HyperIndex project for Monad testnet settlement events.

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
- `ENVIO_GRAPHQL_URL`
- `ENVIO_ADMIN_SECRET` when the GraphQL endpoint requires it

The backend image runs `pnpm db:migrate` before `node dist/main.js`. On Railway, create a Postgres service, then set the backend service variable `DATABASE_URL` as a reference to the database service value, for example `${{Postgres.DATABASE_URL}}` if the service is named `Postgres`. Delete any manually created blank `DATABASE_URL`; Prisma treats an empty string as invalid. Add Redis the same way for `REDIS_URL`. Health checks:

```sh
curl https://<backend-host>/health/live
curl https://<backend-host>/health/indexer
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

## Envio

The indexer folder is ready for Envio Cloud or self-hosting. Envio documents HyperIndex as a GraphQL-producing onchain event indexer with hosted-service and self-hosted deployment options. Envio Cloud is the simpler production path because it manages infrastructure and provides a static GraphQL endpoint; self-hosting requires operating Postgres/Hasura/indexer infrastructure.

Deploy path:

1. Push this repository to GitHub.
2. Connect `indexer/` to Envio Cloud or deploy it on your own infrastructure.
3. Deploy with the public Monad testnet RPC and contract addresses already pinned in `indexer/config.yaml`.
4. Put the resulting GraphQL URL in backend `ENVIO_GRAPHQL_URL`.
5. Put the Hasura/GraphQL admin secret, if required, in backend `ENVIO_ADMIN_SECRET`.
6. Check `/health/indexer` before opening the frontend to testers.

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
