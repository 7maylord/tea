# TEA frontend

Install and run this app from `frontend/`. Copy `.env.example` to `.env.local`, set the public Privy app ID, and enable email login, identity tokens, and Ethereum embedded wallets for that app before running:

```sh
pnpm install
pnpm dev
```

The app runs at <http://127.0.0.1:3000>. Build with `pnpm build` and check lint with `pnpm lint`. Backend dependencies are installed separately in `backend/`.

The onboarding screen uses Privy email sign-in, creates an embedded EVM wallet, syncs its verified identity to the backend, and reserves a handle. Home reads the token balance at a specific block and offers local Anvil test funds on chain ID 31337. The mobile shell has Home, Activity and Profile navigation; Activity explicitly says history is not available yet. Payment screens and live sponsorship verification are still in progress; the browser journey has not been tested with real Privy credentials.
