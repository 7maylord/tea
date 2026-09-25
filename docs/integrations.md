# Integration verification

Checked 18 September 2026. Documentation support is not a completed live integration test.

## Monad testnet contract deployment

Checked 25 September 2026. The contracts were deployed to Monad testnet chain ID 10143 using a valueless `TestUSD` settlement token. Indexers for this deployment should start at block 65515139, the first deployment transaction block.

| Contract | Address | Deployment tx | Block |
|---|---|---|---|
| TestUSD | `0x82cE012544F85E33930C5272bdeAE76736A8F22b` | `0x4a25d2c6716dd8d07bf7c670a401762b7e4450448443a66eaf3d4b88a55d5b0d` | 65515139 |
| TeaStream | `0x3379CdE825960C49b456c62f6bb485902B7dA830` | `0x916d5143e8b1d42db4a37a84408c3aeb901a805507283283339e0be3094192cd` | 65515142 |
| TeaClaimEscrow | `0xF3DeE532B0d0d29c4E4B64b004b7f286E1Cf9814` | `0xc73a5edeed1ac2969a61ed1ecdd60a2389a77fb3263dbf2d1a02eb08e58d07ca` | 65515145 |
| TeaDateUnlock | `0x0A695c494ecF2c18dD26FB60F95FbD7d105EfB84` | `0xc3532722d06207ac3cc6675b7b062e5b8aadd5faf4a1a88114ede21699daead2` | 65515153 |

The deployer `0xAD6433f3a49eb065e6470F231a3dc3Dee26F0f9d` is the initial `TeaClaimEscrow` owner and identity signer. The owner/admin pauses new claim deposits and rotates the identity signer. The identity signer only signs per-claim authorizations after the backend verifies an invited identity; it cannot pause the contract or change signer policy. Rotate `identitySigner` before testing claim flows with a separate backend signer. RPC bytecode checks returned non-empty runtime code for all four deployed addresses.

| Dependency | Verified from official source | Still required |
|---|---|---|
| Monad testnet | Chain ID 10143 is listed in the [Monad changelog](https://docs.monad.xyz/developer-essentials/changelog). The [testnet network page](https://docs.monad.xyz/developer-essentials/testnet) identifies public RPCs and token listings. `backend/` now has a read-only `check:network` command that reports chain ID, token metadata and runtime code hash; it passes on local Anvil. | Run it against the selected testnet RPC and compare address/code hash with an official issuer source; verify the faucet route. No target configuration is present yet. |
| Privy app-pays gas | [Privy's support list](https://docs.privy.io/wallets/gas-and-asset-management/gas/overview) includes Monad Testnet. It describes native EIP-7702 sponsorship for embedded wallets without a separate ERC-4337 settlement address. | Enable TEE execution, billing/credits, client sponsorship and Monad Testnet in the app dashboard; complete an actual sponsored token transfer. |
| Privy client transaction | The [React transaction API](https://docs.privy.io/wallets/using-wallets/ethereum/send-a-transaction) exposes `sponsor: true`; the [setup guide](https://docs.privy.io/wallets/gas-and-asset-management/gas/setup) documents the required dashboard settings. | Pin and test the installed SDK. Verify the returned transaction and recipient balance onchain. |
| TeaStream | Local Anvil create, collect, cancel and final collection passed using the contract in this repository. | Deploy to the selected target network, verify bytecode/address, test sponsored approval/create/collect/cancel and record receipts. |
| Privy identity sync | Backend pins `@privy-io/node` 0.34.0. `/v1/session/sync` verifies an identity token and fetches the current linked accounts as recommended in the [identity-token](https://docs.privy.io/user-management/users/identity-tokens) and [user-query](https://docs.privy.io/user-management/users/managing-users/querying-users) guides. Its database behavior passes a mocked-provider integration test. | Enable identity tokens in the app dashboard and test real OTP, token verification, email/wallet linkage, and recovery with app credentials. |
| Recipient lookup | Exact handle/email lookup rechecks the recipient's current Privy linkage. Redis 7 stores a 5-minute requester-bound destination snapshot and enforces 20 lookups per user per minute, following the [Redis counter pattern](https://redis.io/docs/latest/commands/incr/). Local Postgres/Redis integration tests pass with mocked Privy data. | Validate real provider account changes and consume the reference in payment intents before enabling sends. |
| Privy mobile onboarding | Frontend pins `@privy-io/react-auth` 3.43.0 and wires email login, Ethereum embedded-wallet creation, identity-token sync, handle claim, and an optional passkey offer. Next.js lint and build pass without credentials; the SDK emits optional Farcaster/Solana and Tempo bundling warnings. | Configure an actual Privy app ID and secret, then verify OTP, wallet creation, email recovery, passkey behavior and backend sync on phones. |
| Local test funds | The backend reads ERC-20 balance at a specific Anvil block and restricts its 20 TUSD mint route to a local chain, loopback RPC and the test-only token. Anvil integration test confirms the mint reaches the authenticated account. | Verify the full browser journey with real Privy credentials. This route does not establish target-network token or sponsorship support. |
| Direct payment intents | Local Postgres and Anvil tests verify requester-bound references, integer amounts, idempotency, payer-only recovery and reservations. The API returns an unsigned ERC-20 transfer plan, records one transaction hash, validates the actual transfer and rechecks its receipt on status reads. Unknown hashes stay `RECONCILING` and reserved. | Verify client authorization and sponsorship on the target network, handle safe replacement of an unresolved hash, and define confirmation depth before presenting a send flow. |

No Privy app credentials or target-network RPC configuration are present in this checkout. Gate A and the target-network part of Gate B remain open. Anvil tests cover contract behavior but do not prove Privy sponsorship on Monad.
