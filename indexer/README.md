# TEA event indexer

Envio HyperIndex 3 indexes the Monad testnet settlement token, TeaStream, TeaClaimEscrow and TeaDateUnlock events into `ChainEvent`. Each row is keyed by chain ID, transaction hash and log index; Envio handles chain reorg rollback. The indexer contains only public onchain data. TEA's backend must apply user authorization before returning private activity or threads.

From this folder:

```sh
cp .env.example .env
pnpm install
pnpm codegen
pnpm check
pnpm dev
```

The example sets `ENVIO_PG_PORT=55433` so Envio starts its own Postgres container instead of attaching to another local database on its default port 5433. Adjust the port if 55433 is occupied. The local GraphQL endpoint is `http://127.0.0.1:8080/v1/graphql`; Envio's local Hasura admin secret is `testing`. Keep the Hasura secret on the backend and do not call GraphQL directly from the frontend for private views.

The config is pinned to the Monad testnet deployment recorded in `../docs/integrations.md`, starting at block 65515139. The Monad public RPC currently limits `eth_getLogs` ranges to 100 blocks, so the RPC interval is capped at 100. These deployment values are public onchain config; edit `config.yaml` if the deployment changes.

Envio's [configuration](https://docs.envio.dev/docs/HyperIndex/configuration-file), [event handler](https://docs.envio.dev/docs/HyperIndex/event-handlers) guides describe this configuration.

Date locks emit `LOCK_CREATED` with `lockId`, sender, recipient, amount and `unlockAt`, and `LOCK_WITHDRAWN` with the full paid amount. These are public lifecycle rows; private backend date-lock receipt integration remains a separate checkpoint.
