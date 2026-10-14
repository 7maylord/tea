# TEA — The Everything App

> Send money like a message — even before someone joins.

TEA is a mobile-first PWA for stablecoin payments on Monad testnet. Users sign in with email, create a Mera passkey-derived payment account, pick a unique handle, and send test USD by handle or email. The app supports direct sends, email claim links, funded payment streams, date-locked payments, split requests, and private payment threads.

Built for **Monad Metropolis (Consumer Products & Payments)**.

## Live deployments

- Frontend: https://usetea.vercel.app/
- Backend: https://usetea.up.railway.app/

## Features

- **Email onboarding** — Privy email OTP, Mera passkey payment account, and immutable handle.
- **One passkey, many keys** — the Mera PRF also derives a separate, non-exportable encryption key for a private payment vault; that key never signs blockchain transactions.
- **Direct send** — ERC-20 transfer to another TEA user with backend intent tracking and receipt verification.
- **Send by email** — `TeaClaimEscrow` holds funds for an invited email recipient; unclaimed funds can be refunded after expiry.
- **Streams** — `TeaStream` funds a fixed-duration stream up front; recipients collect accrued funds and senders can cancel the unaccrued remainder.
- **Date unlock** — `TeaDateUnlock` releases the full funded amount to the recipient after a chosen date.
- **Split requests** — offchain split ledger for tracking who should pay whom.
- **Private activity** — backend-owned threads backed by RPC-verified transaction submissions.
- **Test faucet** — authenticated wallets can claim 10,000 TUSD or AUSD and receive a limited MON gas allowance once per UTC day.
- **Mobile PWA** — responsive send, claim, stream, split, and activity flows.

## Deployed Monad testnet contracts

| Contract | Address | Source |
| --- | --- | --- |
| TestUSD (TUSD) | [`0x82cE…F22b`](https://testnet.monadvision.com/address/0x82cE012544F85E33930C5272bdeAE76736A8F22b) | Test token |
| Agora AUSD | [`0xa901…22dC`](https://testnet.monadvision.com/address/0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC) | Agora deployment |
| Agora AUSD Faucet | [`0xd236…ee6C`](https://testnet.monadvision.com/address/0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C) | Agora deployment |
| TeaStream | [`0x3897…5AdC`](https://testnet.monadvision.com/address/0x38977cF2979F5040B5Cc660812e1faF802e15AdC) | [Verified](https://sourcify-api-monad.blockvision.org/v2/contract/10143/0x38977cF2979F5040B5Cc660812e1faF802e15AdC) |
| TeaClaimEscrow | [`0x2cb5…86fA`](https://testnet.monadvision.com/address/0x2cb551cBA355339F3C6b43F931bBFDE60e6986fA) | [Exact match](https://sourcify-api-monad.blockvision.org/v2/contract/10143/0x2cb551cBA355339F3C6b43F931bBFDE60e6986fA) |
| TeaDateUnlock | [`0x73A8…A9b9`](https://testnet.monadvision.com/address/0x73A834d8de5fe088Cb183132358cd98E5fC3A9b9) | [Exact match](https://sourcify-api-monad.blockvision.org/v2/contract/10143/0x73A834d8de5fe088Cb183132358cd98E5fC3A9b9) |

Chain ID: `10143`. The multi-token deployment starts at block `70763435`; Envio indexes TUSD and AUSD transfers plus TEA lifecycle events from that block.

The deployment owner can add a future ERC-20 without redeploying by calling `setTokenSupported(token, true)` on TeaStream, TeaClaimEscrow, and TeaDateUnlock, then adding the address to `SETTLEMENT_TOKENS` and the indexer configuration. Removing support blocks new deposits but does not prevent existing obligations from settling. See [`contracts/README.md`](contracts/README.md) for exact commands.

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
| Identity/wallet | Privy email auth + Mera passkey-derived payment account |
| Indexing | Backend verifies submitted transactions through Monad RPC; optional Envio indexer is deployable for the Metropolis bounty |
| Email | Resend, delivered by the backend claim worker |
| Package management | pnpm, separate lockfiles per app |

## Local development

Prerequisites: Node 20+, pnpm 10, Docker, Foundry, and `jq`.

Start Postgres and Redis with Docker:

```sh
./scripts/docker-local.sh up -d --wait
```

Stop them with:

```sh
./scripts/docker-local.sh down
```

Run the backend and frontend in separate terminals.

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
PORT, APP_ORIGIN
CHAIN_ID, RPC_URL, SETTLEMENT_TOKEN, SETTLEMENT_TOKENS, SETTLEMENT_TOKEN_DECIMALS
AUSD_TOKEN, AUSD_FAUCET_ADDRESS
CLAIM_ESCROW_ADDRESS, TEA_STREAM_ADDRESS, TEA_DATE_UNLOCK_ADDRESS
DATABASE_URL, REDIS_URL
PRIVY_APP_ID, PRIVY_APP_SECRET
IDENTITY_LOOKUP_HMAC_KEY, IDENTITY_ENCRYPTION_KEY
CLAIM_IDENTITY_SIGNER_PRIVATE_KEY, RELAYER_PRIVATE_KEY, FAUCET_PRIVATE_KEY
EMAIL_PROVIDER_KEY, EMAIL_FROM, EMAIL_REPLY_TO
```

Frontend public env:

```text
NEXT_PUBLIC_PRIVY_APP_ID
NEXT_PUBLIC_API_ORIGIN
NEXT_PUBLIC_CHAIN_ID
NEXT_PUBLIC_AURORA_INTENTS_API_KEY
NEXT_PUBLIC_RPC_URL
```

For the current deployment, Railway must use:

```text
SETTLEMENT_TOKEN=0x82cE012544F85E33930C5272bdeAE76736A8F22b
SETTLEMENT_TOKENS=0x82cE012544F85E33930C5272bdeAE76736A8F22b,0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC
AUSD_TOKEN=0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC
AUSD_FAUCET_ADDRESS=0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C
TEA_STREAM_ADDRESS=0x38977cF2979F5040B5Cc660812e1faF802e15AdC
CLAIM_ESCROW_ADDRESS=0x2cb551cBA355339F3C6b43F931bBFDE60e6986fA
TEA_DATE_UNLOCK_ADDRESS=0x73A834d8de5fe088Cb183132358cd98E5fC3A9b9
```

The frontend receives contract addresses and supported-token metadata from authenticated backend responses, so Vercel does not need separate contract-address variables.


## Contracts

- **`TeaClaimEscrow`** — multi-token email-claim deposits, EIP-712 authorization, recipient acceptance, payer refund after expiry.
- **`TeaStream`** — multi-token funded linear streams with recipient withdrawal and sender cancellation.
- **`TeaDateUnlock`** — multi-token funded date locks with recipient withdrawal after unlock.
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
- `GET /v1/balances`
- `POST /v1/payments`
- `POST /v1/claims`
- `POST /v1/streams`
- `POST /v1/date-locks`
- `POST /v1/splits`
- `POST /v1/faucet/claim`
- `GET /v1/activity`
- `GET /v1/threads`

Money-changing endpoints require authentication, `Idempotency-Key`, and backend verification of the submitted transaction.

Email payments are deposited into `TeaClaimEscrow`. The backend sends the recipient a private claim link after deposit confirmation; the recipient signs in with that same email and uses their TEA passkey to collect the funds. The production backend starts the claim worker automatically, so a separate worker service is not required.

## Optional Envio bounty indexer

The app does not require an Envio API URL. The backend verifies submitted transaction receipts directly against Monad RPC before confirming activity. The `indexer/` folder is a standalone Envio HyperIndex deployment for public analytics and the Metropolis bounty. Envio development-plan indexers may be deprecated after 30 days, so redeploy an older instance before judging.

```sh
cd indexer
pnpm install
pnpm codegen
pnpm check
```

## Hackathon sponsor fit

The Metropolis sponsor list includes Envio, Agora, Dynamic, Privy, Mercuryo, Kuru, Chainlink, Perpl, Nansen, MetaMask, Aurora Intents, Alchemy and others. TEA uses Mera as the canonical passkey-derived payment account while Privy handles email login. Aurora Intents adds wallet top-ups into MON, USDC or AUSD on Monad. TEA no longer depends on Envio at runtime because the hosted API URL requires a paid plan for app consumption, but the indexer can still be deployed as a bounty artifact.
