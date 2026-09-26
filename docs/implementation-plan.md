# TEA implementation plan

Delivery order revised 25 September 2026: contract package first, backend second, Envio backend consumption third, frontend last. Required application contracts are TeaStream, TeaClaimEscrow and TeaDateUnlock; direct send uses ERC-20 Transfer and split remains an offchain ledger. Date unlock is required P0 scope. Do not reintroduce Sablier, a root pnpm workspace, or inline ABIs.

Status: in progress. TeaStream, TeaClaimEscrow and TeaDateUnlock pass Foundry tests, are deployed on Monad testnet with the valueless TestUSD token, and were verified by constructor-input matching plus live Envio smoke indexing. The backend already verifies direct payments, claims, refunds and stream creation against Anvil; frontend already has onboarding, direct send, claim, activity and stream paths. Remaining integration work is to point backend flows at the Monad deployment, add date-unlock backend support, consume Envio from the backend for the deployed chain, connect the frontend to those backend flows, then run live Privy sponsorship and two-user browser verification.

Based on `TEA.md` v1.0 and the user's instructions to build our own streaming contract, keep NestJS on Express, and install the frontend and backend separately. Those decisions supersede the Sablier requirements in sections 11, 13, 18, 20–23 and 25, the Fastify choice in section 11, and the root pnpm workspace in sections 11–12. All other P0 requirements remain in scope. Dates below are targets; the submission cutoff still needs official verification.

## Starting point and scope

The repository has a Next.js frontend starter, a NestJS backend starter using Express, and Foundry Counter examples. There is no implemented payment flow. Preserve the three top-level applications, the existing Express adapter, and the working Next.js `app/` layout. Read the installed Next.js guides required by `frontend/AGENTS.md` before editing frontend code.

For local end-to-end checks, run Anvil at chain ID 31337 and Postgres/Redis through Docker Compose as described in `docs/local-development.md`. Exercise two app users against actual local transactions, then restart the API/worker and retry pending operations. These checks supplement, rather than replace, target-network account and sponsorship verification in Gates A and B.

Deliver P0 on test funds: onboarding, sponsored direct sends, email claims/refunds, fully funded streams, date unlock, private threads, Envio receipts, and mobile recovery. P1 remains disabled until all P0 gates pass. Mainnet is a separate reviewed release.

`TEA.md` is currently ignored by Git. Keep this plan's streaming decision tracked; decide whether to track the source specification during repository setup. Existing uncommitted files must be reviewed, not swept into a blanket commit.

## Contract decision: TeaStream replaces Sablier

Build a small non-upgradeable contract with one immutable, verified token per deployment. Use maintained OpenZeppelin token-transfer and reentrancy protections. No NFT, transferable stream rights, yield, protocol fee, arbitrary admin sweep, or upgrade mechanism.

- `create(recipient, amount, duration)` pulls the full amount from `msg.sender`; sets sender, immutable recipient, start to block timestamp, and end to start plus duration; returns a stream ID. Reject zero recipient/amount/duration, timestamp overflow, and unexpected received amounts. Only the configured non-rebasing, non-fee-on-transfer token is supported.
- `withdraw(streamId)` is recipient-only and pays all currently withdrawable funds to the stored recipient. Update accounting before transferring. A zero-available withdrawal reverts with a clear error; the UI disables Collect when zero.
- `cancel(streamId)` is sender-only, once, before end. Freeze accrued entitlement at cancellation and immediately refund only the unaccrued amount to the sender. Previously withdrawn amounts remain accounted for; the recipient can collect the rest later.
- Reads expose total deposited, start/end, withdrawn, canceled state, frozen entitlement, and current withdrawable amount. Emit creation, withdrawal, and cancellation events with public accounting fields and no identity data.

Use overflow-safe integer multiplication/division for `floor(deposit * elapsed / duration)`, clamping elapsed to the duration. At or after end, entitlement is the full deposit; after cancellation it is the frozen entitlement. Total withdrawn + refunded + remaining liability must equal the original deposit. Contract token balance must cover all remaining liabilities; unsolicited token transfers may make it larger.

Pause, if included, blocks only new stream creation. It must not block withdrawals or sender cancellation. Document control and trust assumptions. Native account authorization follows Gate A: the settlement account calls the contract; the relayer gets no unrestricted authority over users' funds.

The chain package implements the spec's create/withdraw/cancel/read adapter against TeaStream's own ABI. Replace `SABLIER_ADDRESS` and `SABLIER_VERSION` with `TEA_STREAM_ADDRESS` and a recorded contract release/ABI version. Envio indexes TeaStream lifecycle events. This adds contract ownership and security work; it does not justify reducing the required accounting tests.

## Required date-unlock checkpoints

1. Contract: fund an immutable recipient and future UTC timestamp; release the full amount once, recipient-only, with no cancellation. Verify boundary, failed-transfer rollback, fuzz and accounting invariant tests; export ABI and index creation/withdrawal events. Commit: `feat: add funded date unlock contracts and indexing`.
2. Monad deployment: deployed all three application contracts and test token, recorded addresses/start blocks, executed date-lock creation and withdrawal, and verified Envio receipts alongside send, claim and stream lifecycles. Completed in `docs: record monad contract deployments` and `test: verify monad contract events`.
3. Backend then Envio then frontend: add date-lock intents, exact transaction/receipt reconciliation, available-balance accounting, date/time review and recipient collection. Verify two-user creation, early-collection rejection, post-date full collection and retry recovery. Commit backend, Envio consumption and frontend separately before release hardening.

## Checkpoints and delivery order

Each checkpoint ends with its verification gate and a concern-scoped commit. Commit subjects below are proposed, single-line Conventional Commits messages. The current finish path starts at checkpoint 4; earlier work is retained as evidence, not as work to repeat.

| Checkpoint | Status | Work | Exit gate | Commit subject |
|---|---|---|---|---|
| 0 — Plan | Done | Record P0 scope, custom stream, Express backend and separate app installs. | Plan covers every P0 journey and test gate. | `docs: record tea implementation plan` |
| 1 — App setup | Done | Separate frontend/backend/indexer installs, local services, env examples, health checks and app skeletons. | Fresh checkout installs in each app folder; apps build; local health checks work. | `chore: establish tea app setup` |
| 2 — Contracts | Done | Implement TestUSD, TeaStream, TeaClaimEscrow and TeaDateUnlock with Foundry unit/fuzz/invariant tests and ABI exports. | `forge build --offline` and `forge test --offline` pass. | `feat: complete tea settlement contracts` |
| 3 — Monad deployment and event proof | Done | Deploy TestUSD plus application contracts, record addresses/start blocks, verify constructor inputs, emit smoke transactions, and index them with Envio. | Deployment records are in `docs/integrations.md`; Envio indexed transfer, stream, claim and date-lock events. | `test: verify monad contract events` |
| 4 — Backend Monad wiring | Next | Point backend config and ABI imports at the deployed Monad addresses; keep one JSON ABI file per contract in `backend/src/abi`; remove Anvil-only assumptions from target-network paths; keep Anvil test paths available. | Backend network check reads Monad chain ID 10143, TestUSD metadata/code, TeaStream, TeaClaimEscrow and TeaDateUnlock runtime code; no secrets or inline ABIs are committed. | `feat: wire backend to monad contracts` |
| 5 — Backend date unlock | Next | Add date-lock intents, approve/create/withdraw plans, idempotent submission, receipt reconciliation, available-balance reservation and early-withdraw rejection. | Integration tests cover create, duplicate submit, early collect rejection, post-date collect, retry after uncertain broadcast and activity projection. | `feat: add date unlock payment intents` |
| 6 — Backend claim/relayer readiness | Next | Finalize claim identity signer and relayer use with separate env vars, signer/address checks, relay/refund recovery and Privy verified-identity checks. | Wrong signer, wrong recipient, forwarded invite, expired claim, duplicate relay and refund retry all fail or recover safely. | `feat: harden claim relay integration` |
| 7 — Envio backend consumption | Next | Run Envio against Monad deployment, configure backend GraphQL consumption, match indexed rows to intents, handle indexer lag and expose private activity/thread views. | Bounded Monad smoke rows appear through backend activity; replaying the same rows is idempotent; missing Envio keeps confirmed intents visible as “activity updating.” | `feat: reconcile monad events into activity` |
| 8 — Frontend contract flows | Next | Use frontend JSON ABIs and deployed addresses for direct send, claim deposit/accept, stream create/collect/cancel and date-lock create/collect; keep Privy sponsor requests on wallet submissions. | Two browser sessions complete direct send, unknown-email claim, stream and date-lock flows against backend plans without inline ABIs. | `feat: connect mobile contract flows` |
| 9 — Gate A live Privy sponsorship | Next | Verify real OTP, embedded wallet creation, backend session sync, settlement address, sponsored direct transfer and sponsored contract call on Monad testnet. | Evidence in `docs/integrations.md` includes tx hashes, wallet address type, sponsorship result and any limitations. | `test: verify privy sponsored monad flow` |
| 10 — Recovery and mobile hardening | Next | Offline/reconnect guards, duplicate-tap recovery, wallet submission uncertainty, worker restart recovery, private cache cleanup, accessibility, safe areas and viewport fixes. | Playwright two-user journeys and manual mobile checks pass for direct, claim, stream and date-lock flows. | `fix: harden mobile payment recovery` |
| 11 — Release evidence | Last | Threat model, signer/pause/refund runbooks, deployment records, measured latency, demo script and submission draft. | At least 20 representative transactions measured with p50/p95; unresolved limitations are disclosed. | `docs: prepare verified tea demo and release evidence` |

Do not make empty commits merely to match this table. If a checkpoint touches unrelated systems, split it into smaller concern-specific commits while keeping the tree buildable after each commit.

## Verification rules

- Contracts: `forge build`, `forge fmt --check`, and `forge test` in `contracts/`, including unit, fuzz and invariant coverage. Test the selected account signature path and real deployed lifecycles, not just EOA mocks.
- Backend: build, non-mutating lint, Jest integration tests against isolated Postgres/Redis, and API end-to-end tests. The starter lint script uses `--fix`; add a check-only CI command during setup.
- Frontend: build, lint and Playwright two-user journeys, plus manual iOS Safari and Android Chrome checks at 320, 360–430, 768 and 1280 CSS px. Measure the spec's performance targets under recorded device/network conditions.
- Security/recovery: wrong user access, invalid identity proofs, mismatched idempotency payload, broadcast timeout, worker restart, queue retry, delayed/orphaned events, sponsorship exhaustion, offline/resume and private-cache inspection.
- At each commit: review only intended paths, inspect the staged diff for secrets/generated noise, run the relevant checks and record results. Keep the tree buildable. Never use blanket staging over the current dirty tree, push, or rewrite pushed history.

## Release blockers and optional work

Gate A still blocks claiming the app has sponsored target-network UX, even though the contracts and Envio event paths are verified. Record evidence and resolve the blocker before expanding scope; do not fabricate integrations or animate simulated settlement.

If Privy sponsorship fails on Monad testnet, keep the deployed contracts and backend reconciliation, record the failure in `docs/integrations.md`, and switch the demo wording to user-paid testnet gas unless the user explicitly chooses another sponsor path. Do not add bundler/paymaster infrastructure unless the verified Privy path fails and a new decision records the change.

After all P0 gates pass, consider one P1 feature with remaining time: pay link/QR, then split ledger, then verified Aurora/AUSD. External integration work requires Gate C. Date unlock is required and uses separately tested all-at-once contract semantics.
