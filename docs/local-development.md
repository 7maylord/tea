# Local end-to-end stack

Run Postgres and Redis in Docker:

```sh
docker compose -f infrastructure/compose.yaml up -d --wait
```

Run Anvil in another terminal:

```sh
anvil --host 127.0.0.1 --port 8545 --chain-id 31337
```

Deploy the local-only faucet token and stream from `contracts/` using an unlocked Anvil account:

```sh
ANVIL_SENDER=$(cast rpc eth_accounts --rpc-url http://127.0.0.1:8545 | jq -r '.[0]')
forge script script/LocalDeploy.s.sol:LocalDeployScript --rpc-url http://127.0.0.1:8545 --sender "$ANVIL_SENDER" --unlocked --broadcast
```

The script prints the token and stream addresses. Use its faucet only on Anvil; the contract rejects deployment on any other chain ID.

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

For identity sync, enable identity tokens in the Privy app, set `PRIVY_APP_ID` and `PRIVY_APP_SECRET`, and generate **two separate** 32-byte base64 secrets with `openssl rand -base64 32`. Set those as `IDENTITY_LOOKUP_HMAC_KEY` and `IDENTITY_ENCRYPTION_KEY`. `POST /v1/session/sync` accepts the Privy identity token in the `privy-id-token` header. It verifies the token, fetches current linked accounts from Privy, and refuses an unverified email or missing embedded EVM wallet. With Docker Postgres running, run `pnpm test:identity` from `backend/` with the local `DATABASE_URL` above; this exercises HTTP and database behavior using mocked Privy data. A live Privy test remains part of Gate A.

Run the apps in separate terminals:

```sh
cd backend && pnpm run start:dev
cd frontend && pnpm install && pnpm run dev
```

Use separate terminals for those two commands. The API defaults to port 3001 and Next.js to port 3000.
`GET http://127.0.0.1:3001/health/live` checks that the API process is serving requests; it does not test database or queue readiness.

These credentials and Anvil accounts are for local tests only. Stop services with `docker compose -f infrastructure/compose.yaml down`. Add `-v` only when you intend to delete the local database and queue state.

Once the app flows are implemented, run two-user send, claim/refund and stream journeys against this stack, including a backend/worker restart and a repeated submission. The local run proves app behavior; the target-network sponsorship and deployment gates in the implementation plan remain separate.
