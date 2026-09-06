# TEA contracts

`TeaStream` is a fully funded linear stream for one immutable ERC-20 token. The recipient can collect accrued funds; the sender can cancel before the end and recover only the unaccrued portion. It does not support fee-on-transfer or rebasing tokens. An external identity service is not involved in stream withdrawals.

From the repository root, initialize dependencies with `git submodule update --init --recursive`. From `contracts/`, run:

```sh
forge build --offline
forge test --offline
forge fmt --check
```

`script/TeaStream.s.sol` deploys with the token address supplied through `SETTLEMENT_TOKEN`. Verify the network, token code and decimals, deployer account, and sponsorship path before using it on a testnet. Record the deployed address, bytecode and transaction in `docs/integrations.md`. No deployment is performed by the local test suite.

The current tests cover vesting, collection, cancellation, rounding, token-transfer rejection, access control, and aggregate backing. A live sponsored create/collect/cancel cycle is still required for Gate B in `docs/implementation-plan.md`.
