# TEA — The Everything App

> Send money like a message — even before someone joins.

TEA is a mobile-first PWA for instant and programmable stablecoin payments. Send dollars by handle or email, let someone claim money before they have an account, and stream pay over time from the same payment thread. Recipients start with an email address; TEA handles wallet setup and transaction fees.

Built for **Monad Metropolis (Consumer Products & Payments)**.

## Live deployments

- Frontend: https://usetea.vercel.app/
- Backend: https://usetea.up.railway.app/

## Features

- **Email OTP onboarding + embedded wallet + unique handle** via Privy.
- **Direct send to existing users** — ordinary ERC-20 `transfer` from the sender's settlement wallet. Immutable intents, idempotency keys, reservations, reconnect/refresh recovery, no double-send.
- **Email claim escrow** (`TeaClaimEscrow`) — send to an email with no TEA account. 14-day expiry, opaque invite link, 5-minute EIP-712 identity authorization + recipient EIP-712 acceptance, relayer submission, payer-only refund.
- **Funded linear streams** (`TeaStream`) — fully funded, fixed-duration, recipient collects accrued funds, sender can cancel and recover only the unaccrued portion.
- **Payment threads + private activity** — one thread per user pair per chain; direct payments, claimed email payments, and streams share a thread. Envio supplies canonical receipts; confirmed chain state wins over optimistic UI.
- **Mobile PWA** — works at 320 CSS px, primary 360–430 px, verified 768/1280 px; 44px touch targets, 16px inputs, safe areas, skeletons, offline send blocking, service worker excludes private routes.

## Repo layout

```text
tea/
  frontend/       # Next.js App Router PWA (auth, send, claims, streams, activity)
  backend/        # NestJS API + workers (auth, users, payments, claims, streams, activity)
    src/modules: identity/, funds/, payments/, claims/, streams/
    prisma/       # schema + migrations
    scripts/      # check-network.mjs
    test/         # *.integration-spec.ts per domain
  contracts/      # Foundry: TeaClaimEscrow, TeaStream, scripts, abi/, tests
  indexer/        # Envio HyperIndex config, schema, handlers
  infrastructure/ # compose.yaml (Postgres 16, Redis 7)
  docs/           # local-development, integrations, implementation-plan, decisions/
  TEA.md          # Product + Technical Requirements v1.0 (implementation spec)
  TAB_SPEC.md     # Superseded predecessor spec
```

## Stack

| Component       | Choice                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------ |
| Frontend        | Next.js 16, React 19, TypeScript, Tailwind 4, PWA + Playwright                             |
| Backend         | NestJS 11 + Express, TypeScript, Prisma 6 + Postgres 16, Redis 7                           |
| Chain client    | viem 2.56.7, shared typed ABIs, explicit chain config                                      |
| Contracts       | Solidity + Foundry, OpenZeppelin (submodules)                                              |
| Identity/wallet | Privy (`@privy-io/react-auth` 3.43.0, `@privy-io/node` 0.34.0), EIP-7702 app-pays (Gate A) |
| Indexing        | Envio HyperIndex 3 → backend GraphQL consumption                                           |
| Email           | Resend                                                                                     |
| Package mgmt    | pnpm, separate lockfiles per app (`frontend/`, `backend/`, `indexer/`)                     |

## Prerequisites

- Node 20+, pnpm 10, Docker, Foundry (`forge`, `cast`, `anvil`), `jq`

## Quickstart (local Anvil stack)

```sh
# 1. Local services
docker compose -f infrastructure/compose.yaml up -d --wait

# 2. Anvil (new terminal)
anvil --host 127.0.0.1 --port 8545 --chain-id 31337

# 3. Deploy faucet token + stream + escrow (from contracts/)
git submodule update --init --recursive
ANVIL_SENDER=$(cast rpc eth_accounts --rpc-url http://127.0.0.1:8545 | jq -r '.[0]')
forge script script/LocalDeploy.s.sol:LocalDeployScript \
  --rpc-url http://127.0.0.1:8545 --sender "$ANVIL_SENDER" --unlocked --broadcast
# note printed TOKEN / STREAM / ESCROW addresses

# 4. Chain sanity check
TEA_TOKEN_ADDRESS=<token> TEA_STREAM_ADDRESS=<stream> bash contracts/script/smoke-anvil.sh

# 5. Backend (from backend/)
cp .env.example .env   # fill SETTLEMENT_TOKEN, TEA_STREAM_ADDRESS, CLAIM_ESCROW_ADDRESS + keys below
pnpm install
DATABASE_URL=postgresql://tea:tea_local_only@127.0.0.1:55432/tea pnpm db:generate
DATABASE_URL=postgresql://tea:tea_local_only@127.0.0.1:55432/tea pnpm db:migrate
set -a; . ./.env; set +a
pnpm run start:dev     # :3001, GET /health/live

# 6. Frontend (from frontend/)
cp .env.example .env   # NEXT_PUBLIC_PRIVY_APP_ID, NEXT_PUBLIC_API_ORIGIN, NEXT_PUBLIC_CHAIN_ID=31337
pnpm install
pnpm run dev           # http://127.0.0.1:3000

# 7. Indexer (from indexer/)
cp .env.example .env   # override addresses if LocalDeploy printed different ones
pnpm install
pnpm codegen && pnpm check
ENVIO_TUI=false ENVIO_PG_PORT=55433 pnpm dev  # GraphQL http://127.0.0.1:8080/v1/graphql
```

Then: verify network config, run domain tests (below), onboard two test users in the browser, `Get 20 test USD`, send → claim → stream. Stop with `docker compose -f infrastructure/compose.yaml down` (`-v` wipes local DB/queue).

## Configuration

Backend `backend/.env.example` (never commit real values):

```text
APP_ENV, PORT, APP_ORIGIN, API_ORIGIN
CHAIN_ID, RPC_URL, SETTLEMENT_TOKEN, SETTLEMENT_TOKEN_DECIMALS
CLAIM_ESCROW_ADDRESS, TEA_STREAM_ADDRESS
DATABASE_URL, REDIS_URL, ENVIO_GRAPHQL_URL, ENVIO_ADMIN_SECRET
PRIVY_APP_ID, PRIVY_APP_SECRET
IDENTITY_LOOKUP_HMAC_KEY, IDENTITY_ENCRYPTION_KEY (openssl rand -base64 32, separate)
CLAIM_IDENTITY_SIGNER_PRIVATE_KEY, RELAYER_PRIVATE_KEY (Anvil-only keys locally)
EMAIL_PROVIDER_KEY, EMAIL_FROM
FEATURE_DATE_UNLOCK, FEATURE_SPLITS, FEATURE_AURORA (all false in P0)
```

Frontend (`NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_API_ORIGIN`, `NEXT_PUBLIC_CHAIN_ID` — only `31337`/`10143` enable sign-in). Indexer (`ENVIO_RPC_URL`, `SETTLEMENT_TOKEN`, `TEA_STREAM_ADDRESS`, `CLAIM_ESCROW_ADDRESS`, `ENVIO_PG_PORT=55433` to avoid clashing with local Postgres).

Before touching any settlement network, from `backend/`:

```sh
pnpm check:network  # asserts RPC chain ID, token bytecode/metadata/decimals at one block
```

## Contracts (`contracts/`)

Only two app contracts in P0. Direct sends are plain ERC-20 transfers — no intermediary contract. Group split (P1) is an offchain request ledger, not a pooled contract.

- **`TeaStream`** — `create(recipient, amount, duration)`, recipient-only `withdraw`, sender-only pre-end `cancel`. Accrual: `floor(D * clamp(t-s,0,d) / d)`. Cancel freezes entitlement, refunds only unaccrued funds. Emits `StreamCreated/Withdrawn/Canceled`. ABI: `abi/TeaStream.json` (regen: `forge build --offline && jq '.abi' out/TeaStream.sol/TeaStream.json > abi/TeaStream.json`).
- **`TeaClaimEscrow`** — one immutable token, 14-day expiry. `deposit(claimId, commitment, amount)`, `claim(authorization, identitySignature, recipientSignature)` (EIP-712 domain `TeaClaimEscrow` v1 + ERC-1271 for smart accounts), `refund(claimId)` to stored payer only. Emits `ClaimDeposited/Paid/Refunded`. ABI: `abi/TeaClaimEscrow.json`. Pause blocks deposits/claims only; signer rotation increments epoch and invalidates outstanding authorizations; admin can never sweep user funds.
- Scripts: `LocalDeploy.s.sol` (Anvil faucet+stream+escrow), `TeaStream.s.sol` (`SETTLEMENT_TOKEN`), `TeaClaimEscrow.s.sol` (+ `CLAIM_IDENTITY_SIGNER`, `CLAIM_ADMIN`).

```sh
forge build --offline && forge test --offline && forge fmt --check
```

## Backend (`backend/`)

- `POST /v1/session/sync` (privy-id-token header) → verifies Privy token, links email + embedded wallet, creates user/account.
- `POST /v1/me/handle` — immutable `[a-z0-9_]{3,20}`, one winner on races.
- `POST /v1/resolve` — exact handle/email → expiring requester-bound recipient reference (Redis, 20/min/user). Unknown verified email → `unregistered` (claim path).
- `POST /v1/payments` + `POST /v1/payments/:id/submission` + `GET /v1/payments/:id` — immutable intent + ERC-20 transfer plan, independent onchain verification, `RECONCILING` on unknown hashes.
- `POST /v1/claims`, `POST /v1/claims/:id/deposit`, `POST /v1/claims/resolve-link`, `POST /v1/claims/:id/authorize`, `POST /v1/claims/:id/submit`, `POST /v1/claims/:id/resend` (1/min, 5/24h), `POST /v1/claims/:id/refund` + `start:claim-worker` (invite/relay/refund outbox jobs).
- `POST /v1/streams`, `POST /v1/streams/:id/submission`, `GET /v1/streams/:id`, `POST /v1/streams/:id/withdraw|cancel`, `POST /v1/streams/:id/actions/:actionId/submission`.
- `GET /v1/activity`, `GET /v1/threads`, `GET /v1/threads/:id` — payer sees pending attempts, recipient only confirmed; Envio `indexedReceipt` attached only on canonical match.
- All money mutations require auth + `Idempotency-Key` + request-hash check (same key+payload replays, differing payload conflicts).

## Frontend (`frontend/`)

`app/`: `tea-app.tsx` shell, `send-flow.tsx` (Now / Over time), `claim-send.tsx`, `claim/[token]/`, `stream-send.tsx` + `stream-card.tsx`, `activity.tsx`, `payment-plan.ts` / `claim-plan.ts` / `stream-plan.ts` (exact-calldata validation before signing). Claim pages disable referrers/caching and reveal amounts only after matching-email verification. Stream cards tick from chain time + monotonic clock, mark stale offline.

```sh
pnpm install && pnpm dev
pnpm exec playwright install chromium
pnpm build && pnpm test:e2e   # public shell at 320/390/768/1280 px
```

Live two-user Privy journey needs controlled test emails + target-network sponsorship (Gate A).

## Indexer (`indexer/`)

Envio indexes `ERC20.Transfer` (known wallets), `TeaStream` lifecycle, `TeaClaimEscrow` lifecycle into `ChainEvent` keyed by `(chainId, txHash, logIndex)` with reorg rollback. Contains only public onchain data — backend enforces authorization. Local chain `31337`; target network needs reviewed chain ID/addresses/start blocks.

## Testing

| Layer     | Command (per-folder)                            | Covers                                                                                                              |
| --------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------ | ---------- | ------------- | ----------- | ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Contracts | `forge test --offline`                          | vesting, collect, cancel, rounding dust, token-failure rejection, access control, aggregate backing, fuzz/invariant |
| Backend   | `pnpm test:db                                   | test:identity                                                                                                       | test:resolve | test:funds | test:payments | test:claims | test:streams` | Postgres/Redis/Anvil integration per domain; idempotency, reservations, signature-gated relay, refunds, conservation |
| Frontend  | `pnpm test:plan`, `pnpm build && pnpm test:e2e` | plan validation, public PWA shell matrix                                                                            |
| Manual    | two phones/browsers                             | OTP → handle → send → claim → stream collect/cancel, refresh/suspend recovery, worker restart + resubmission        |

`GET /health/live` is liveness only (not DB/queue readiness).
