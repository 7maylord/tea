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

Constructor-input verification compared each deployment transaction input with the local artifact creation bytecode plus encoded constructor args. All four matched. Source publication to Sourcify/MonadScan was not submitted because it publishes this repository's contract source and metadata to an external verifier and needs explicit approval.

| Contract | Creation input match | Creation input keccak |
|---|---:|---|
| TestUSD | yes | `0x4f9043f64d38f6c0b641612d05b9c2cdf0f9e8e2d85008f7e679454e474a5b8b` |
| TeaStream | yes | `0xed9184a17380c25c6421379c9f79eee38667b842d6eeb007821e5bbed9adc1d9` |
| TeaClaimEscrow | yes | `0xa2fc8e4044af9e7493e1d00e5be647767ea675f29f9b301bfdc0fb3cbd9a4793` |
| TeaDateUnlock | yes | `0x62dd46711335e50fd3e7f9904ef845fc841690dd7fa5eaaaee1f3d7c7ef10a96` |

A bounded Monad smoke run emitted and indexed the required events with Envio from blocks 65636945 through 65637302. The generated rows covered `TRANSFER`, `STREAM_CREATED`, `STREAM_CANCELED`, `CLAIM_DEPOSITED`, `CLAIM_PAID`, `LOCK_CREATED`, `STREAM_WITHDRAWN` and `LOCK_WITHDRAWN`. The committed Envio config starts from deployment block 65515139 and caps RPC log ranges at 100 blocks for Monad's public RPC.

| Flow | Transaction | Indexed event rows |
|---|---|---|
| Mint test funds | `0x7f50cef02508d132a73066197bf9aae4dca92d686b12de13934e9a8d83b84e5c` | `TRANSFER` |
| Direct send | `0x0b6f121a918f16e8fba317b69dcfe1f16a05fe7d5340825e08e48347fdc8f203` | `TRANSFER` |
| Create stream #1 | `0x7db65998a5eb2842d2602e6af51bc175bcb1e84b24671b107c37c01b091fcee7` | `TRANSFER`, `STREAM_CREATED` |
| Create stream #2 | `0xe9f0d757ddf4a18ca72b3b704a039cd4134631c50004048a3079cf70674df3da` | `TRANSFER`, `STREAM_CREATED` |
| Cancel stream #2 | `0xab75fce7174028cd9eacae804d84cb6860cf05efe5767a97c8118cf348048321` | `TRANSFER`, `STREAM_CANCELED` |
| Deposit claim | `0x971e3537a7a2b16972fef32909296aafe7f9cea205e8ac1eeeafdf591b988f84` | `TRANSFER`, `CLAIM_DEPOSITED` |
| Pay claim | `0x536039641c270ed92355e7cc3cf8ffe0e3dce4d508154cc0051f6bb9ada98c72` | `TRANSFER`, `CLAIM_PAID` |
| Create date lock #1 | `0xe3ed53bb3b1fd5ce3a8d9565da048cb2e2a7492b3f88100f8ca264799c61d26e` | `TRANSFER`, `LOCK_CREATED` |
| Withdraw stream #1 | `0xbd51fee5500bdae61a40c65e9df0bdc9824a19948c542c81756a0398361ecd29` | `TRANSFER`, `STREAM_WITHDRAWN` |
| Withdraw date lock #1 | `0x9af773384ba8df4794fd29aefb587bf4845efe08ad05d10e41303e0ff33f05bb` | `TRANSFER`, `LOCK_WITHDRAWN` |

| Dependency | Verified from official source | Still required |
|---|---|---|
| Monad testnet | Chain ID 10143 is listed in the [Monad changelog](https://docs.monad.xyz/developer-essentials/changelog). Contracts are deployed on Monad testnet, runtime code is present, constructor input matches local artifacts, and Envio indexed smoke events from Monad RPC. | Publish source verification to Sourcify/MonadScan after explicit approval, or keep bytecode verification as the internal check. |
| Privy app-pays gas | [Privy's support list](https://docs.privy.io/wallets/gas-and-asset-management/gas/overview) includes Monad Testnet. It describes native EIP-7702 sponsorship for embedded wallets without a separate ERC-4337 settlement address. | Enable TEE execution, billing/credits, client sponsorship and Monad Testnet in the app dashboard; complete an actual sponsored token transfer. |
| Privy client transaction | The [React transaction API](https://docs.privy.io/wallets/using-wallets/ethereum/send-a-transaction) exposes `sponsor: true`; the [setup guide](https://docs.privy.io/wallets/gas-and-asset-management/gas/setup) documents the required dashboard settings. | Pin and test the installed SDK. Verify the returned transaction and recipient balance onchain. |
| TeaStream | Local Anvil tests pass. Monad smoke created, canceled and withdrew streams, and Envio indexed `STREAM_CREATED`, `STREAM_CANCELED` and `STREAM_WITHDRAWN`. | Connect backend/frontend flows to the deployed addresses and Privy sponsorship. |
| Privy identity sync | Backend pins `@privy-io/node` 0.34.0. `/v1/session/sync` verifies an identity token and fetches the current linked accounts as recommended in the [identity-token](https://docs.privy.io/user-management/users/identity-tokens) and [user-query](https://docs.privy.io/user-management/users/managing-users/querying-users) guides. Its database behavior passes a mocked-provider integration test. | Enable identity tokens in the app dashboard and test real OTP, token verification, email/wallet linkage, and recovery with app credentials. |
| Recipient lookup | Exact handle/email lookup rechecks the recipient's current Privy linkage. Redis 7 stores a 5-minute requester-bound destination snapshot and enforces 20 lookups per user per minute, following the [Redis counter pattern](https://redis.io/docs/latest/commands/incr/). Local Postgres/Redis integration tests pass with mocked Privy data. | Validate real provider account changes and consume the reference in payment intents before enabling sends. |
| Privy mobile onboarding | Frontend pins `@privy-io/react-auth` 3.43.0 and wires email login, Ethereum embedded-wallet creation, identity-token sync, handle claim, and an optional passkey offer. Next.js lint and build pass without credentials; the SDK emits optional Farcaster/Solana and Tempo bundling warnings. | Configure an actual Privy app ID and secret, then verify OTP, wallet creation, email recovery, passkey behavior and backend sync on phones. |
| Local test funds | The backend reads ERC-20 balance at a specific Anvil block and restricts its 20 TUSD mint route to a local chain, loopback RPC and the test-only token. Anvil integration test confirms the mint reaches the authenticated account. | Verify the full browser journey with real Privy credentials. This route does not establish target-network token or sponsorship support. |
| Direct payment intents | Local Postgres and Anvil tests verify requester-bound references, integer amounts, idempotency, payer-only recovery and reservations. The API returns an unsigned ERC-20 transfer plan, records one transaction hash, validates the actual transfer and rechecks its receipt on status reads. Unknown hashes stay `RECONCILING` and reserved. | Verify client authorization and sponsorship on the target network, handle safe replacement of an unresolved hash, and define confirmation depth before presenting a send flow. |

Monad contract deployment and event indexing are verified. Gate A and the target-network part of Gate B still need real Privy OTP, wallet creation and sponsored transaction testing through the app.
