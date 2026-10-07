# TEA — The Everything App

> Send money like a message — even before someone joins.

TEA is a mobile-first PWA for stablecoin payments on Monad testnet. Users sign in with email, get a Privy embedded wallet, pick a unique handle, and send test USD by handle or email. The app supports direct sends, email claim links, funded payment streams, date-locked payments, split requests, and private payment threads.

Built for **Monad Metropolis (Consumer Products & Payments)**.

## Live deployments

- Frontend: https://usetea.vercel.app/
- Backend: https://usetea.up.railway.app/

## Features

- **Email onboarding** — Privy email OTP, embedded wallet, and immutable handle.
- **Direct send** — ERC-20 transfer to another TEA user with backend intent tracking and receipt verification.
- **Send by email** — `TeaClaimEscrow` holds funds for an invited email recipient; unclaimed funds can be refunded after expiry.
- **Streams** — `TeaStream` funds a fixed-duration stream up front; recipients collect accrued funds and senders can cancel the unaccrued remainder.
- **Date unlock** — `TeaDateUnlock` releases the full funded amount to the recipient after a chosen date.
- **Split requests** — offchain split ledger for tracking who should pay whom.
- **Private activity** — backend-owned threads backed by RPC-verified transaction submissions.
- **Mobile PWA** — responsive send, claim, stream, split, and activity flows.

## Deployed Monad testnet contracts

| Contract | Address |
| --- | --- |
| TestUSD | `0x82cE012544F85E33930C5272bdeAE76736A8F22b` |
| TeaStream | `0x3379CdE825960C49b456c62f6bb485902B7dA830` |
| TeaClaimEscrow | `0xF3DeE532B0d0d29c4E4B64b004b7f286E1Cf9814` |
| TeaDateUnlock | `0x0A695c494ecF2c18dD26FB60F95FbD7d105EfB84` |

Chain ID: `10143`. Optional Envio bounty indexers should start at block `65515139`.

## Repo layout

```text
tea/
  frontend/       # Next.js App Router PWA
  backend/        # NestJS API, Prisma, workers, payment orchestration
  contracts/      # Foundry contracts, deployment scripts, ABI exports
  indexer/        # Optional Envio HyperIndex bounty deployment
  infrastructure/ # Docker compose templates
  docs/           # deployment notes, integrations, implementation history
```

## Stack

| Component | Choice |
| --- | --- |
| Frontend | Next.js 16, React 19, TypeScript, Tailwind 4, PWA |
| Backend | NestJS 11 + Express, Prisma 6, Postgres, Redis |
| Chain client | viem 2.56.7 with JSON ABI imports |
| Contracts | Solidity, Foundry, OpenZeppelin |
| Identity/wallet | Privy email auth + embedded wallets |
| Indexing | Backend verifies submitted transactions through Monad RPC; optional Envio indexer is deployable for the Metropolis bounty |
| Email | Resend |
| Package management | pnpm, separate lockfiles per app |

## Local development

Prerequisites: Node 20+, pnpm 10, Docker, Foundry, and `jq`.

Start Postgres and Redis:

```sh
docker compose -f infrastructure/compose.yaml up -d --wait
```

Backend:

```sh
cd backend
cp .env.example .env
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm start:dev
```

Frontend:

```sh
cd frontend
cp .env.example .env
pnpm install
pnpm dev
```


Local backend health:

```sh
curl http://127.0.0.1:3001/health/live
```

## Configuration

Backend env lives in `backend/.env` locally and platform env vars in production:

```text
APP_ENV, PORT, APP_ORIGIN, API_ORIGIN
CHAIN_ID, RPC_URL, SETTLEMENT_TOKEN, SETTLEMENT_TOKEN_DECIMALS
CLAIM_ESCROW_ADDRESS, TEA_STREAM_ADDRESS, TEA_DATE_UNLOCK_ADDRESS
DATABASE_URL, REDIS_URL
PRIVY_APP_ID, PRIVY_APP_SECRET
IDENTITY_LOOKUP_HMAC_KEY, IDENTITY_ENCRYPTION_KEY
CLAIM_IDENTITY_SIGNER_PRIVATE_KEY, RELAYER_PRIVATE_KEY
EMAIL_PROVIDER_KEY, EMAIL_FROM
```

Frontend public env:

```text
NEXT_PUBLIC_PRIVY_APP_ID
NEXT_PUBLIC_API_ORIGIN
NEXT_PUBLIC_CHAIN_ID
NEXT_PUBLIC_SETTLEMENT_TOKEN
NEXT_PUBLIC_CLAIM_ESCROW_ADDRESS
NEXT_PUBLIC_TEA_STREAM_ADDRESS
NEXT_PUBLIC_TEA_DATE_UNLOCK_ADDRESS
NEXT_PUBLIC_AURORA_INTENTS_API_KEY
```


## Contracts

- **`TeaClaimEscrow`** — email-claim deposits, EIP-712 authorization, recipient acceptance, payer refund after expiry.
- **`TeaStream`** — funded linear streams with recipient withdrawal and sender cancellation.
- **`TeaDateUnlock`** — funded date locks with recipient withdrawal after unlock.
- **`TestUSD`** — test settlement token for Monad testnet.

Useful checks:

```sh
cd contracts
forge build --offline
forge test --offline
forge fmt --check
```

## Backend API

Main endpoints:

- `POST /v1/session/sync`
- `POST /v1/me/handle`
- `POST /v1/resolve`
- `POST /v1/payments`
- `POST /v1/claims`
- `POST /v1/streams`
- `POST /v1/date-locks`
- `POST /v1/splits`
- `GET /v1/activity`
- `GET /v1/threads`

Money-changing endpoints require authentication, `Idempotency-Key`, and backend verification of the submitted transaction.

## Optional Envio bounty indexer

The app does not require an Envio API URL. The backend verifies submitted transaction receipts directly against Monad RPC before confirming activity. The `indexer/` folder is kept as a standalone Envio HyperIndex deployment for Metropolis judging and the Envio bounty. Per the Metropolis note, development-plan indexers older than 30 days are deprecated, so create or redeploy the Envio Cloud deployment on or after September 27 for judging.

```sh
cd indexer
pnpm install
pnpm codegen
pnpm check
```

## Hackathon sponsor fit

The Metropolis sponsor list includes Envio, Agora, Dynamic, Privy, Mercuryo, Kuru, Chainlink, Perpl, Nansen, MetaMask, Aurora Intents, Alchemy and others. TEA uses Aurora Intents for wallet top-ups into MON, USDC or AUSD on Monad, and includes a Mera passkey-derived recovery wallet demo in the profile screen. TEA no longer depends on Envio at runtime because the hosted API URL requires a paid plan for app consumption, but the indexer can still be deployed as a bounty artifact.
