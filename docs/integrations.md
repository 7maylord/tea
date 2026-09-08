# Integration verification

Checked 18 September 2026. Documentation support is not a completed live integration test.

| Dependency | Verified from official source | Still required |
|---|---|---|
| Monad testnet | Chain ID 10143 is listed in the [Monad changelog](https://docs.monad.xyz/developer-essentials/changelog). The [testnet network page](https://docs.monad.xyz/developer-essentials/testnet) identifies public RPCs and token listings. | Confirm configured RPC with `eth_chainId`; verify settlement token address, bytecode, decimals and faucet route on the current testnet. |
| Privy app-pays gas | [Privy's support list](https://docs.privy.io/wallets/gas-and-asset-management/gas/overview) includes Monad Testnet. It describes native EIP-7702 sponsorship for embedded wallets without a separate ERC-4337 settlement address. | Enable TEE execution, billing/credits, client sponsorship and Monad Testnet in the app dashboard; complete an actual sponsored token transfer. |
| Privy client transaction | The [React transaction API](https://docs.privy.io/wallets/using-wallets/ethereum/send-a-transaction) exposes `sponsor: true`; the [setup guide](https://docs.privy.io/wallets/gas-and-asset-management/gas/setup) documents the required dashboard settings. | Pin and test the installed SDK. Verify the returned transaction and recipient balance onchain. |
| TeaStream | Local Anvil create, collect, cancel and final collection passed using the contract in this repository. | Deploy to the selected target network, verify bytecode/address, test sponsored approval/create/collect/cancel and record receipts. |

No Privy app credentials or target-network RPC configuration are present in this checkout. Gate A and the target-network part of Gate B remain open. Anvil tests cover contract behavior but do not prove Privy sponsorship on Monad.
