# TEA contracts

`TeaStream` is a fully funded linear stream for one immutable ERC-20 token. The recipient can collect accrued funds; the sender can cancel before the end and recover only the unaccrued portion. It does not support fee-on-transfer or rebasing tokens. An external identity service is not involved in stream withdrawals.

Index `StreamCreated`, `StreamWithdrawn` and `StreamCanceled` by contract address and chain. Each event indexes the stream ID, sender and recipient. Creation records the deposit and start/end timestamps; withdrawals record the amount paid; cancellation records the recipient's frozen entitlement and sender refund. Sum withdrawals by stream ID to reconstruct collected funds. Read the immutable token from `token()`. Use the transaction hash, log index and block hash from the chain log for deduplication and reorg checks; those are not event arguments.

The tracked ABI is `abi/TeaStream.json`. After changing the contract, run `forge build --offline` and then `jq '.abi' out/TeaStream.sol/TeaStream.json > abi/TeaStream.json` from this folder.

`TeaClaimEscrow` locks one immutable ERC-20 token for 14 days. A relayer can pay a recipient before expiry only with the identity signer's EIP-712 `ClaimAuthorization` and the recipient's separate EIP-712 `ClaimAcceptance`. The acceptance contains the authorization digest. The domain is `TeaClaimEscrow` version `1` on the current chain and escrow address. The deployed recipient account may validate its signature through ERC-1271. At or after expiry, anyone can trigger a refund, always to the stored payer. The contract holds only an opaque identity commitment; the backend verifies identity and issues five-minute authorizations. It rejects unexpected token amounts on deposit and payout, so use a verified non-rebasing, non-fee-on-transfer token.

Index `ClaimDeposited`, `ClaimPaid`, and `ClaimRefunded` by escrow address and chain. Deposits include claim ID, payer, commitment, amount, and expiry; payouts include claim ID, payer, recipient, and amount; refunds include claim ID, payer, and amount. The commitment is public but contains no raw identity and must use a unique private salt. Deduplicate with transaction hash, log index, and block hash. The tracked ABI is `abi/TeaClaimEscrow.json`; regenerate it with `jq '.abi' out/TeaClaimEscrow.sol/TeaClaimEscrow.json > abi/TeaClaimEscrow.json` after a build.

The admin may pause new deposits and claims and rotate the identity signer, which increments the signer epoch and invalidates earlier authorizations. Neither pause nor signer rotation blocks expired refunds. The admin cannot withdraw escrowed funds. A compromised identity signer can authorize an attacker-controlled recipient; recipient acceptance alone cannot prevent that. Protect the signer and admin keys. Deployed smart-account acceptance and sponsorship still require live verification beyond the local ERC-1271 test.

From the repository root, initialize dependencies with `git submodule update --init --recursive`. From `contracts/`, run:

```sh
forge build --offline
forge test --offline
forge fmt --check
```

`script/TeaStream.s.sol` deploys with the token address supplied through `SETTLEMENT_TOKEN`. Verify the network, token code and decimals, deployer account, and sponsorship path before using it on a testnet. Record the deployed address, bytecode and transaction in `docs/integrations.md`. No deployment is performed by the local test suite.

`script/TeaClaimEscrow.s.sol` also requires `CLAIM_IDENTITY_SIGNER` and `CLAIM_ADMIN` addresses. `script/LocalDeploy.s.sol` deploys the faucet token, stream and escrow on Anvil. Its escrow signer and admin default to Anvil's first account; set `LOCAL_ACCOUNT` to use another local account. Do not use the local faucet or local signer arrangement with real funds.

The current tests cover vesting, collection, cancellation, rounding, token-transfer rejection, access control, and aggregate backing. A live sponsored create/collect/cancel cycle is still required for Gate B in `docs/implementation-plan.md`.
