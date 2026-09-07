# Local end-to-end stack

Run Postgres and Redis in Docker:

```sh
docker compose -f infrastructure/compose.yaml up -d --wait
```

Run Anvil in another terminal:

```sh
anvil --host 127.0.0.1 --port 8545 --chain-id 31337
```

Deploy the local-only faucet token and stream from `contracts/` using an unlocked Anvil account:

```sh
ANVIL_SENDER=$(cast rpc eth_accounts --rpc-url http://127.0.0.1:8545 | jq -r '.[0]')
forge script script/LocalDeploy.s.sol:LocalDeployScript --rpc-url http://127.0.0.1:8545 --sender "$ANVIL_SENDER" --unlocked --broadcast
```

The script prints the token and stream addresses. Use its faucet only on Anvil; the contract rejects deployment on any other chain ID.

Run the chain lifecycle check with those addresses:

```sh
TEA_TOKEN_ADDRESS=<token-address> TEA_STREAM_ADDRESS=<stream-address> bash contracts/script/smoke-anvil.sh
```

Local connection values:

```text
DATABASE_URL=postgresql://tea:tea_local_only@127.0.0.1:55432/tea
REDIS_URL=redis://127.0.0.1:6380
RPC_URL=http://127.0.0.1:8545
CHAIN_ID=31337
```

These credentials and Anvil accounts are for local tests only. Stop services with `docker compose -f infrastructure/compose.yaml down`. Add `-v` only when you intend to delete the local database and queue state.

Once the app flows are implemented, run two-user send, claim/refund and stream journeys against this stack, including a backend/worker restart and a repeated submission. The local run proves app behavior; the target-network sponsorship and deployment gates in the implementation plan remain separate.
