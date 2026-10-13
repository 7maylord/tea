# TEA event indexer

This standalone Envio HyperIndex deployment indexes TEA's public Monad testnet activity. The application backend does not depend on its GraphQL endpoint; it verifies submitted receipts directly through Monad RPC. The indexer remains useful for public analytics and the Metropolis Envio bounty.

## Indexed deployment

- chain ID: `10143`
- start block: `70763435`
- settlement tokens: TUSD and Agora AUSD
- TeaStream: `0x38977cF2979F5040B5Cc660812e1faF802e15AdC`
- TeaClaimEscrow: `0x2cb551cBA355339F3C6b43F931bBFDE60e6986fA`
- TeaDateUnlock: `0x73A834d8de5fe088Cb183132358cd98E5fC3A9b9`

`ChainEvent` rows are keyed by chain ID, transaction hash, and log index. Each lifecycle event stores the settlement token address, participants, amount, block information, and the relevant stream, claim, or lock identifier. Envio handles rollback during chain reorganizations.

The configuration subscribes to:

- ERC-20 `Transfer` for TUSD and AUSD
- `StreamCreated`, `StreamWithdrawn`, and `StreamCanceled`
- `ClaimDeposited`, `ClaimPaid`, and `ClaimRefunded`
- `LockCreated` and `LockWithdrawn`

The public Monad RPC caps log ranges at 100 blocks, so `config.yaml` sets both the initial interval and ceiling to 100.

## Local development

```sh
cd indexer
cp .env.example .env
pnpm install
pnpm codegen
pnpm check
pnpm dev
```

The example uses port `55433` for Envio's Postgres container. The local GraphQL endpoint is `http://127.0.0.1:8080/v1/graphql`, and the local Hasura admin secret is `testing`.

## Deployment maintenance

The RPC URL, addresses, and start block in `config.yaml` are public chain configuration and do not require deployment secrets. When adding another settlement token, add its address to the `SettlementToken` address list. When replacing a TEA contract, update its address and choose a start block at or before the deployment block, then run:

```sh
pnpm codegen
pnpm check
```

Deploy or redeploy the generated indexer through Envio Cloud when a fresh judging deployment is required. Envio development-plan deployments may be deprecated after 30 days.

See Envio's [configuration](https://docs.envio.dev/docs/HyperIndex/configuration-file) and [event handler](https://docs.envio.dev/docs/HyperIndex/event-handlers) documentation.
