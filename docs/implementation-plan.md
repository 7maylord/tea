# TEA implementation plan

Status: in progress. TeaStream passes local Foundry tests. Identity storage, session sync, handle reservation, exact recipient lookup and direct-intent registration pass local tests with mocked Privy data and real Anvil transfers. Client authorization and sponsorship are not implemented. Gates A and B still require live integration verification.

Based on `TEA.md` v1.0 and the user's instructions to build our own streaming contract, keep NestJS on Express, and install the frontend and backend separately. Those decisions supersede the Sablier requirements in sections 11, 13, 18, 20–23 and 25, the Fastify choice in section 11, and the root pnpm workspace in sections 11–12. All other P0 requirements remain in scope. Dates below are targets; the submission cutoff still needs official verification.

## Starting point and scope

The repository has a Next.js frontend starter, a NestJS backend starter using Express, and Foundry Counter examples. There is no implemented payment flow. Preserve the three top-level applications, the existing Express adapter, and the working Next.js `app/` layout. Read the installed Next.js guides required by `frontend/AGENTS.md` before editing frontend code.

For local end-to-end checks, run Anvil at chain ID 31337 and Postgres/Redis through Docker Compose as described in `docs/local-development.md`. Exercise two app users against actual local transactions, then restart the API/worker and retry pending operations. These checks supplement, rather than replace, target-network account and sponsorship verification in Gates A and B.

Deliver P0 on test funds: onboarding, sponsored direct sends, email claims/refunds, fully funded streams, private threads, Envio receipts, and mobile recovery. P1 remains disabled until all P0 gates pass. Mainnet is a separate reviewed release.

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

## Checkpoints and delivery order

Each checkpoint ends with its verification gate and a concern-scoped commit. Commit subjects below are proposed, single-line Conventional Commits messages. Dependencies follow row order unless stated otherwise.

| Checkpoint | Work | Exit gate | Commit subject |
|---|---|---|---|
| 0 — Plan | Record this scope and custom-stream decision. | Plan covers every P0 journey and test gate. | `docs: record tea implementation plan` |
| 1 — App setup | Separate frontend/backend pnpm lockfiles and installs, Postgres/Redis local services, placeholder env files, health checks and CI. Preserve the NestJS Express adapter, the working frontend layout and Foundry setup; remove examples when replacements land. | Fresh checkout installs in each app folder; both apps build; existing tests run; local services and health endpoints work. | `chore: establish tea app setup` |
| 2 — Gate A, by Sep 19 | Verify official network/token configuration, Privy OTP, settlement account control and sponsored transfer. Pin one account mode and sponsorship policy in an ADR. Verify account activation, typed signatures and approvals, including ERC-1271 if selected. | Real sponsored transfer on the target network; stable settlement address; supported signing path; evidence in `docs/integrations.md`. | `feat: verify sponsored settlement account flow` |
| 3 — Gate B, by Sep 20 | Implement TeaStream, Foundry unit/fuzz/invariant tests, deployment script and ABI export; exercise sponsored create/withdraw/cancel using Gate A. | Real testnet lifecycle; conservation and rights tests pass; deployment bytecode/address/version recorded. Document any missed date as a blocker. | `feat: implement funded linear stream contract` |
| 4 — Data and identity | Prisma migrations, users/identities/accounts, immutable handles, session validation, encrypted identity storage, versioned HMAC lookup and exact recipient resolution. Add shared integer-money/schema utilities only where used. | Duplicate sync is safe; handle races have one winner; spoofed/unverified identities fail; normalization and resource authorization tests pass. | `feat: establish verified identities and recipient lookup` |
| 5 — Mobile onboarding | OTP, handle creation, settlement account setup, nonblocking passkey offer, email recovery, safe return paths, Home/Activity/Profile shell and test-funds flow. | A new user reaches Home or resumes a claim on a phone; unsupported passkeys do not block receiving. | `feat: add mobile onboarding and test funding` |
| 6 — Direct-send backend, Sep 21–24 | Immutable intents, request-hash idempotency, durable transaction attempts, reservations, transaction-plan validation, sponsorship limits and RPC reconciliation. | Double tap and timeout after broadcast cannot create a second transfer; available balance never double-subtracts a settled payment. | `feat: implement recoverable direct payment intents` |
| 7 — Receipt indexing | Envio token events, canonical log identities, intent/log matching, private threads/activity, authenticated updates and polling recovery. | Replay/out-of-order logs do not duplicate receipts; orphaned logs roll back projections; indexer lag preserves confirmed status. | `feat: reconcile indexed payments into private receipts` |
| 8 — Direct-send UI | Recipient/amount/review flow, first-payment confirmation, submit/reconcile/confirm states, balance freshness and thread receipts. | Two phones exchange sponsored test tokens; refresh and suspension recover the same payment. | `feat: complete mobile direct payment journey` |
| 9 — Claim contract, Sep 25–30 | TeaClaimEscrow with 14-day expiry, exact token funding, EIP-712 identity authorization plus recipient acceptance, replay controls, signer rotation, pause and payer-only refund destination. | Unit/fuzz/invariant tests cover the full signature matrix, terminal payout uniqueness, expiry boundary, races, reentrancy and token failure. | `feat: implement identity-bound claim escrow` |
| 10 — Claim backend | Private per-claim commitments, hashed invite links, five-minute authorizations, wallet-control verification, outbox/BullMQ workers for invite/relay/refund, rate limits and recovery. | Invite follows confirmed deposit; forwarded link and wrong email fail; duplicate jobs never repeat financial operations; refund retry checks chain state. | `feat: orchestrate claim invitations and refunds` |
| 11 — Claim UI | Unknown-email composer path, minimal landing, matching-email verification, resumed acceptance, claim/refund states and resend controls. | New recipient claims on a second phone; mail failure does not repeat deposit; expiry shows refundable/pending until chain confirmation. | `feat: complete mobile claim and refund journey` |
| 12 — Stream backend, Oct 1–4 | TeaStream transaction adapter, exact approvals or atomic batch, intents, sponsorship and Envio event projections. | Fund/create, partial collect, cancel and final collect reconcile against contract state; approval alone is never success. | `feat: integrate stream transactions and receipts` |
| 13 — Stream UI | Over time mode, upfront-lock and cancellation terms, thread card, chain-time estimate, Collect/Cancel and stale indicators. | Collected funds alone become Available; canceled entitlement stops growing; end-time dust is collected; both users see consistent receipts. | `feat: add mobile stream collection and cancellation` |
| 14 — P0 hardening, Oct 5–7 | Manifest/icons/service worker, private network-only routes, logout cleanup, offline transaction blocking, accessibility, safe areas, keyboard and reconnect fixes. Add two-user Playwright journeys. | Required browser/viewport matrix and failure scenarios pass; at least 4 of 5 first-time testers claim without coaching. | `fix: harden mobile payment recovery and accessibility` |
| 15 — Release evidence, Oct 8–10 | Threat model, outage/signer/pause/refund runbooks, deployment records, measured timings, demo guide and submission draft. | At least 20 successful representative transactions measured with p50/p95 and failures separately counted; 90–120 second honest demo and working evidence links. | `docs: prepare verified tea demo and release evidence` |
| 16 — Freeze, Oct 11–12 | Run full P0 regression on frozen deployments, resolve release blockers, verify official submission requirements and submit before cutoff. Oct 13 is buffer only. | Submission acceptance recorded; unresolved limitations disclosed. | `docs: record final release verification` |

Split checkpoint 14 fixes into smaller concern-specific commits if unrelated issues arise. Do not make empty commits merely to match this table. Submission work requires access to the actual portal; a prepared draft is not evidence of submission.

## Verification rules

- Contracts: `forge build`, `forge fmt --check`, and `forge test` in `contracts/`, including unit, fuzz and invariant coverage. Test the selected account signature path and real deployed lifecycles, not just EOA mocks.
- Backend: build, non-mutating lint, Jest integration tests against isolated Postgres/Redis, and API end-to-end tests. The starter lint script uses `--fix`; add a check-only CI command during setup.
- Frontend: build, lint and Playwright two-user journeys, plus manual iOS Safari and Android Chrome checks at 320, 360–430, 768 and 1280 CSS px. Measure the spec's performance targets under recorded device/network conditions.
- Security/recovery: wrong user access, invalid identity proofs, mismatched idempotency payload, broadcast timeout, worker restart, queue retry, delayed/orphaned events, sponsorship exhaustion, offline/resume and private-cache inspection.
- At each commit: review only intended paths, inspect the staged diff for secrets/generated noise, run the relevant checks and record results. Keep the tree buildable. Never use blanket staging over the current dirty tree, push, or rewrite pushed history.

## Release blockers and optional work

Gate A blocks dependent money flows if authorization or sponsorship is unsupported. Gate B blocks stream integration if conservation, access control or the deployed lifecycle fails. Record evidence and resolve the blocker before expanding scope; do not fabricate integrations or animate simulated settlement.

If custom streams cannot be delivered safely, explicitly revise the demo to Send + Claim with the user; do not silently drop a P0 requirement. If deadlines slip, cut optional work first and report the revised schedule.

After all P0 gates pass, consider one P1 feature with remaining time: pay link/QR, then split ledger, then verified Aurora/AUSD, then date unlock. External integration work requires Gate C. A date unlock needs separately tested all-at-once contract semantics; it is not a disguised linear stream.
