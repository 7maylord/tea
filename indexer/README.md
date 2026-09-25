# TEA event indexer

Envio HyperIndex 3 indexes the local settlement token, TeaStream, TeaClaimEscrow and TeaDateUnlock events into `ChainEvent`. Each row is keyed by chain ID, transaction hash and log index; Envio handles chain reorg rollback. The indexer contains only public onchain data. TEA's backend must apply user authorization before returning private activity or threads.

Run Anvil and deploy the contracts as described in `../docs/local-development.md`. Then, from this folder:

```sh
cp .env.example .env
pnpm install
pnpm codegen
pnpm check
pnpm dev
```

The example sets `ENVIO_PG_PORT=55433` so Envio starts its own Postgres container instead of attaching to another local database on its default port 5433. Adjust the port if 55433 is occupied. The local GraphQL endpoint is `http://127.0.0.1:8080/v1/graphql`; Envio's local Hasura admin secret is `testing`. Keep the Hasura secret on the backend and do not call GraphQL directly from the frontend for private views.

The config defaults to the addresses printed by the standard Anvil deployment. Override the four contract addresses and `ENVIO_RPC_URL` in `.env` if the deployment changes. A target-network indexer needs a separately reviewed chain ID, addresses and deployment start blocks.

Envio's [configuration](https://docs.envio.dev/docs/HyperIndex/configuration-file), [event handler](https://docs.envio.dev/docs/HyperIndex/event-handlers) and [local Anvil](https://docs.envio.dev/docs/HyperIndex/local-anvil) guides describe this configuration.

Date locks emit `LOCK_CREATED` with `lockId`, sender, recipient, amount and `unlockAt`, and `LOCK_WITHDRAWN` with the full paid amount. These are public lifecycle rows; private backend date-lock receipt integration remains a separate checkpoint.
