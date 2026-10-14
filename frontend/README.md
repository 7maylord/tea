# TEA frontend

The Next.js PWA provides TEA's landing page and authenticated payment experience. Privy handles email login; Mera creates and protects the canonical payment key with a passkey. Returning users can browse the app after Privy login and use the passkey only when authorizing payment actions.

Production app: <https://usetea.vercel.app/>

## Local setup

The frontend and backend have separate dependencies and lockfiles. Start the backend on port 3001, then run:

```sh
cd frontend
cp .env.example .env
pnpm install
pnpm dev
```

Open <http://127.0.0.1:3000>. Required public configuration:

- `NEXT_PUBLIC_PRIVY_APP_ID`
- `NEXT_PUBLIC_API_ORIGIN`
- `NEXT_PUBLIC_CHAIN_ID`
- `NEXT_PUBLIC_RPC_URL`
- `NEXT_PUBLIC_AURORA_INTENTS_API_KEY` for Aurora top-ups

These values are embedded at build time. Update the Vercel project variables and redeploy after changing one of them. Contract addresses and supported tokens come from backend transaction plans and balance responses.

## Payment flow

The wallet card loads every token returned by `/v1/balances` and lets the user choose the active settlement token. That choice follows direct sends, email claims, streams, date locks, splits, activity amounts, and the daily faucet. Current tokens are TUSD and Agora AUSD.

The backend prepares calldata but never signs for the user. Before opening Mera, the frontend validates the destination contract, chain, token, recipient, amount, and relevant timing fields against the user's intended action. Submitted transaction recovery data is kept separately per user and token in session storage.

The same Mera passkey can unlock a second, domain-separated AES-GCM key for the private payment vault. The encryption key is non-exportable and never signs blockchain transactions; only the encrypted note, IV, and version are stored locally.

Aurora Intents provides top-up routes into USDC, AUSD, or MON on Monad. It is separate from TEA's settlement-token selector: received AUSD can be used directly in TEA, while other received assets must be supported by the backend and all three TEA contracts before appearing as settlement options.

## Checks

```sh
pnpm lint
pnpm test:plan
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

The plan tests ensure modified token, recipient, amount, chain, contract, and action data is rejected before signing. Playwright covers the public shell and responsive layouts; live Privy/Mera payment testing requires test accounts and Monad testnet funds.
