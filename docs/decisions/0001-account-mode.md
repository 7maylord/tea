# 0001: settlement account mode

Status: provisional until Gate A live transfer passes.

Use the user's Privy embedded EVM wallet address as TEA's settlement address. For target-network app-pays fees, use Privy's native EIP-7702 sponsorship, subject to a live Monad Testnet test. This keeps incoming tokens, balances and direct sends at one address. Do not create a separate ERC-4337 smart-account address unless the live sponsorship or required signature path fails and a new decision records the change.

[Privy's sponsorship overview](https://docs.privy.io/wallets/gas-and-asset-management/gas/overview) lists Monad Testnet and distinguishes native sponsorship from separate smart wallets. [Setup documentation](https://docs.privy.io/wallets/gas-and-asset-management/gas/setup) requires TEE execution and dashboard configuration. A documented `sponsor: true` request is not proof that a particular app has those settings or credits.

Before marking this decision final, verify email onboarding, stable wallet address, sponsored token transfer, wallet control and typed-data acceptance on the chosen chain. An EIP-7702 upgraded wallet may use ERC-1271 validation; test the exact recipient signature path against the deployed claim contract. Record RPC, token, SDK version, transaction hashes and outcomes in `docs/integrations.md`.
