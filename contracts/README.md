# TEA contracts

`TeaStream` is a fully funded linear stream for one immutable ERC-20 token. The recipient can collect accrued funds; the sender can cancel before the end and recover only the unaccrued portion. It does not support fee-on-transfer or rebasing tokens. An external identity service is not involved in stream withdrawals.

Index `StreamCreated`, `StreamWithdrawn` and `StreamCanceled` by contract address and chain. Each event indexes the stream ID, sender and recipient. Creation records the deposit and start/end timestamps; withdrawals record the amount paid; cancellation records the recipient's frozen entitlement and sender refund. Sum withdrawals by stream ID to reconstruct collected funds. Read the immutable token from `token()`. Use the transaction hash, log index and block hash from the chain log for deduplication and reorg checks; those are not event arguments.

The tracked ABI is `abi/TeaStream.json`. After changing the contract, run `forge build --offline` and then `jq '.abi' out/TeaStream.sol/TeaStream.json > abi/TeaStream.json` from this folder.

From the repository root, initialize dependencies with `git submodule update --init --recursive`. From `contracts/`, run:

```sh
forge build --offline
forge test --offline
forge fmt --check
```

`script/TeaStream.s.sol` deploys with the token address supplied through `SETTLEMENT_TOKEN`. Verify the network, token code and decimals, deployer account, and sponsorship path before using it on a testnet. Record the deployed address, bytecode and transaction in `docs/integrations.md`. No deployment is performed by the local test suite.

The current tests cover vesting, collection, cancellation, rounding, token-transfer rejection, access control, and aggregate backing. A live sponsored create/collect/cancel cycle is still required for Gate B in `docs/implementation-plan.md`.
