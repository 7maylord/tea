# TEA contracts

TEA uses three non-upgradeable, multi-token contracts on Monad testnet. Direct sends and split payments use ordinary ERC-20 transfers and do not pass through a TEA contract.

| Contract | Purpose | Address | Verification |
| --- | --- | --- | --- |
| TeaStream | Fully funded linear payment streams | [`0x38977cF2979F5040B5Cc660812e1faF802e15AdC`](https://testnet.monadvision.com/address/0x38977cF2979F5040B5Cc660812e1faF802e15AdC) | [Sourcify runtime match](https://sourcify-api-monad.blockvision.org/v2/contract/10143/0x38977cF2979F5040B5Cc660812e1faF802e15AdC) |
| TeaClaimEscrow | Fourteen-day email claim escrow | [`0x2cb551cBA355339F3C6b43F931bBFDE60e6986fA`](https://testnet.monadvision.com/address/0x2cb551cBA355339F3C6b43F931bBFDE60e6986fA) | [Sourcify exact runtime match](https://sourcify-api-monad.blockvision.org/v2/contract/10143/0x2cb551cBA355339F3C6b43F931bBFDE60e6986fA) |
| TeaDateUnlock | Fully funded payment released after a timestamp | [`0x73A834d8de5fe088Cb183132358cd98E5fC3A9b9`](https://testnet.monadvision.com/address/0x73A834d8de5fe088Cb183132358cd98E5fC3A9b9) | [Sourcify exact runtime match](https://sourcify-api-monad.blockvision.org/v2/contract/10143/0x73A834d8de5fe088Cb183132358cd98E5fC3A9b9) |

Chain ID is `10143`; deployment begins at block `70763435`. The deployment owner and claim identity signer are `0xAD6433f3a49eb065e6470F231a3dc3Dee26F0f9d`.

## Supported tokens

Each payment stores its ERC-20 address, and liabilities are tracked independently per token. The current allowlist is:

| Token | Address | Decimals |
| --- | --- | --- |
| TEA Test USD (TUSD) | `0x82cE012544F85E33930C5272bdeAE76736A8F22b` | 6 |
| Agora AUSD | `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` | 6 |

The contracts reject unsupported and fee-on-transfer tokens. Removing a token from the allowlist blocks new deposits while existing claims, streams, and date locks can still settle.

The owner can add another deployed ERC-20 without replacing the TEA contracts:

```sh
export TOKEN_TO_ADD=0xYourTokenAddress
export MONAD_RPC_URL=https://testnet-rpc.monad.xyz

cast send 0x38977cF2979F5040B5Cc660812e1faF802e15AdC \
  'setTokenSupported(address,bool)' "$TOKEN_TO_ADD" true \
  --rpc-url "$MONAD_RPC_URL" --private-key "$OWNER_PRIVATE_KEY"
cast send 0x2cb551cBA355339F3C6b43F931bBFDE60e6986fA \
  'setTokenSupported(address,bool)' "$TOKEN_TO_ADD" true \
  --rpc-url "$MONAD_RPC_URL" --private-key "$OWNER_PRIVATE_KEY"
cast send 0x73A834d8de5fe088Cb183132358cd98E5fC3A9b9 \
  'setTokenSupported(address,bool)' "$TOKEN_TO_ADD" true \
  --rpc-url "$MONAD_RPC_URL" --private-key "$OWNER_PRIVATE_KEY"
```

Then add the address to the backend `SETTLEMENT_TOKENS` list and the Envio `SettlementToken` addresses. The frontend obtains token symbols, decimals, and balances from the backend.

## Contract behavior

- `TeaClaimEscrow` accepts an opaque identity commitment and holds funds for 14 days. A claim requires the backend identity signer's EIP-712 authorization and the recipient account's EIP-712 acceptance. After expiry, anyone may trigger a refund to the original payer.
- `TeaStream` holds the full stream amount at creation. The recipient withdraws accrued funds; the sender may cancel before the end and recover only the unaccrued amount.
- `TeaDateUnlock` holds the full amount until its UTC timestamp. Only the fixed recipient may withdraw, once, at or after that time.
- `TestUSD` is an unrestricted Monad-testnet token with no cash value. Standard ERC-20 `Transfer` events cover mints and direct sends.

All lifecycle events include the token address so an indexer can reconstruct per-token activity and liabilities. The owner can manage token support, pause new escrow deposits and claims, and rotate the claim identity signer. The owner cannot withdraw user funds.

## Build and test

Initialize dependencies once from the repository root:

```sh
git submodule update --init --recursive
```

Run the contract checks from this directory:

```sh
forge build --offline
forge test --offline
forge fmt --check
python3 test/check_indexer_events.py
```

The suite covers access control, signature domains, expiry boundaries, reentrancy, unsupported and fee-on-transfer tokens, per-token liabilities, payout conservation, and a 128,000-call stateful accounting invariant.

## Deploy, export, and verify

Copy `.env.example` to the ignored `.env`, set the deployer, admin, identity signer, settlement tokens, and Monad RPC URL, then run:

```sh
forge script script/MonadDeploy.s.sol:MonadDeployScript \
  --rpc-url "$MONAD_TESTNET_RPC_URL" --broadcast
```

Export ABIs after every contract change:

```sh
jq '.abi' out/TeaClaimEscrow.sol/TeaClaimEscrow.json > abi/TeaClaimEscrow.json
jq '.abi' out/TeaStream.sol/TeaStream.json > abi/TeaStream.json
jq '.abi' out/TeaDateUnlock.sol/TeaDateUnlock.json > abi/TeaDateUnlock.json
```

The frontend and backend keep their own JSON ABI copies. Update those copies and `abi/monad-testnet.json` in both applications whenever addresses or interfaces change.

Monad Sourcify verification requires the trailing slash on the verifier URL:

```sh
forge verify-contract CONTRACT_ADDRESS src/Contract.sol:Contract \
  --chain 10143 \
  --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org/ \
  --constructor-args "$(cast abi-encode 'constructor(address)' OWNER_ADDRESS)"
```
