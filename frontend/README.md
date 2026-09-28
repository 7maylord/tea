# TEA frontend

Install and run this app from `frontend/`. Copy `.env.example` to `.env`, set the public Privy app ID, and enable email login and Ethereum embedded wallets for that app before running:

```sh
pnpm install
pnpm dev
```

The app runs at <http://127.0.0.1:3000>. Backend dependencies are installed separately in `backend/`. Run the browser checks after a production build:

```sh
pnpm exec playwright install chromium
pnpm build
pnpm test:e2e
```

The mobile PWA supports Privy onboarding, direct payments, email claims, funded streams, private activity, reload recovery, and offline transaction blocking. The checked-in browser suite covers the public shell at 320, 390, 768, and 1280 CSS pixels. A live two-user Privy journey still requires controlled test emails and target-network sponsorship.
