# TEA contracts

The P0 contract package contains three application contracts: `TeaClaimEscrow` for payments to an email that has not joined TEA, `TeaStream` for fully funded payments over time, and `TeaDateUnlock` for all-at-once release on a future date. A direct send to an existing user calls the configured ERC-20 token's `transfer` function from that user's settlement wallet; TEA does not interpose another contract. This keeps the recipient transfer direct and avoids a second approval or custody layer.

`TestUSD` is a separate test asset, labeled `TEA Test USD (no cash value)` / `TUSD`, with six decimals and unrestricted minting for testers. Its constructor permits only Monad testnet (10143). Standard ERC-20 Transfer events cover mints and sends for the existing Envio token handler. It is not USDC, redeemable dollars, or a production asset.

Copy `.env.example` to `.env` for `script/MonadDeploy.s.sol`. Set `SETTLEMENT_TOKEN` to the zero address to deploy a new TestUSD together with all three application contracts; use an existing token address to reuse it. `CLAIM_ADMIN` is the public wallet address controlling pause and signer rotation (it has no escrow withdrawal power). `CLAIM_IDENTITY_SIGNER` is the public address matching the backend's `CLAIM_IDENTITY_SIGNER_PRIVATE_KEY`, used to attest verified claim recipients. Use your deployer wallet as testnet admin and a separate backend signing wallet. The identity signer need not hold MON just to sign authorizations; the transaction relayer pays gas. Keep all private keys in ignored env files, never in tracked deployment records.

Group split is P1 and is not a pooled smart contract. The specified design is an offchain request ledger: each member's obligation creates a normal direct-payment intent to the organizer, successful transfers remain final, and expiry closes only unpaid requests. Add that backend and UI feature after the P0 release gates pass; it does not add another contract to this package.

`TeaDateUnlock` is required scope. `create(recipient, amount, unlockAt)` funds the entire payment immediately, using a future Unix UTC timestamp. The immutable recipient can call `withdraw(lockId)` at or after that timestamp to receive the entire amount once. There is no early withdrawal, sender cancellation, administrator, or automatic scheduled transaction. Only the configured non-rebasing, non-fee-on-transfer token is supported.

Index `LockCreated` and `LockWithdrawn` by contract address and chain. Both events index lock ID, sender and recipient; creation includes amount and unlock timestamp, and withdrawal includes the paid amount. The tracked ABI is `abi/TeaDateUnlock.json`; regenerate with `jq '.abi' out/TeaDateUnlock.sol/TeaDateUnlock.json > abi/TeaDateUnlock.json`. Tests cover the exact timestamp boundary, full single payout, recipient rights, invalid terms, failed-transfer rollback and aggregate backing.

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
python3 test/check_indexer_events.py
```

The stateful accounting invariant randomizes funding, time advancement, stream collection/cancellation and claim/refund settlement and date-lock collection across all three contracts. It checks that every deposited unit is paid or held as a backed liability. The indexer check rejects stale exported ABIs and lifecycle subscription/handler drift; it does not replace live indexed-receipt verification after deployment.

`script/TeaStream.s.sol` deploys with the token address supplied through `SETTLEMENT_TOKEN`. Verify the network, token code and decimals, deployer account, and sponsorship path before using it on a testnet. Record the deployed address, bytecode and transaction in `docs/integrations.md`. No deployment is performed by the local test suite.

`script/TeaClaimEscrow.s.sol` also requires `CLAIM_IDENTITY_SIGNER` and `CLAIM_ADMIN` addresses. Use the Monad deployment scripts and records for app integration; there is no app-level local settlement deployment path.

The current tests cover vesting, collection, cancellation, rounding, token-transfer rejection, access control, and aggregate backing. A live sponsored create/collect/cancel cycle is still required for Gate B in `docs/implementation-plan.md`.
