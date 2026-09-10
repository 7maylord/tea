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
Set `SETTLEMENT_TOKEN` in `backend/.env` to the printed token address. Set `TEA_STREAM_ADDRESS` to the printed stream address for later stream checks.

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

Set `NEXT_PUBLIC_PRIVY_APP_ID` and `NEXT_PUBLIC_API_ORIGIN` in `frontend/.env.local` (copy `frontend/.env.example` first). The Privy app ID is public; keep `PRIVY_APP_SECRET` only in the backend environment. The API allows the origin in `APP_ORIGIN` for browser requests. Open the frontend at that exact origin, such as `http://127.0.0.1:3000` for the local example.

The API defaults to port 3001 and Next.js to port 3000.
`GET http://127.0.0.1:3001/health/live` checks that the API process is serving requests; it does not test database or queue readiness.

After onboarding and claiming a handle, Home reads the token balance at a specific Anvil block. **Get 20 test USD** submits a local mint to the signed-in wallet; refresh the balance to see it after confirmation. The API ignores client-supplied recipients and amounts. The faucet is available only with `APP_ENV=local`, chain ID 31337, a loopback Anvil RPC and the local-only token. From `backend/`, run `RPC_URL=http://127.0.0.1:8545 SETTLEMENT_TOKEN=<token-address> pnpm test:funds` to check a real mint and balance read; this test substitutes a verified session because live Privy credentials are still required for browser onboarding.

These credentials and Anvil accounts are for local tests only. Stop services with `docker compose -f infrastructure/compose.yaml down`. Add `-v` only when you intend to delete the local database and queue state.

Once the app flows are implemented, run two-user send, claim/refund and stream journeys against this stack, including a backend/worker restart and a repeated submission. The local run proves app behavior; the target-network sponsorship and deployment gates in the implementation plan remain separate.
