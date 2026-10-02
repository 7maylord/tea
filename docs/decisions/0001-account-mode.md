# 0001: settlement account mode

Status: revised after Gate A sponsorship failure.

Use the user's Privy embedded EVM wallet address as TEA's settlement address. Live Monad Testnet sponsorship failed with `App secret is required for gas sponsored transactions`, so current testnet transactions are user-paid from funded embedded wallets. This keeps incoming tokens, balances and direct sends at one address. Do not create a separate ERC-4337 smart-account address unless the user chooses a new sponsor path and a new decision records the change.

[Privy's sponsorship overview](https://docs.privy.io/wallets/gas-and-asset-management/gas/overview) lists Monad Testnet and distinguishes native sponsorship from separate smart wallets. [Setup documentation](https://docs.privy.io/wallets/gas-and-asset-management/gas/setup) requires TEE execution and dashboard configuration. A documented `sponsor: true` request is not proof that a particular app has those settings or credits.

Before release, verify email onboarding, stable wallet address, user-paid token transfer, wallet control and typed-data acceptance on the chosen chain. If sponsorship is reintroduced later, test the exact sponsored path and record RPC, token, SDK version, transaction hashes and outcomes in `docs/integrations.md`.
