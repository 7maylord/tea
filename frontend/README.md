# TEA frontend

Install and run this app from `frontend/`. Copy `.env.example` to `.env.local`, set the public Privy app ID, and enable email login, identity tokens, and Ethereum embedded wallets for that app before running:

```sh
pnpm install
pnpm dev
```

The app runs at <http://127.0.0.1:3000>. Build with `pnpm build` and check lint with `pnpm lint`. Backend dependencies are installed separately in `backend/`.

The onboarding screen uses Privy email sign-in, creates an embedded EVM wallet, syncs its verified identity to the backend, and reserves a handle. Payment screens and live sponsorship verification are still in progress; onboarding has only been build-tested without real Privy credentials.
