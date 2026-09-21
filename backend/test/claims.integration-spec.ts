import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  type Address,
} from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { processNextClaimInvite } from '../src/claims/invite.worker';
import { processNextClaimRefund } from '../src/claims/refund.worker';
import { processNextClaimRelay } from '../src/claims/relay.worker';
import {
  claimAcceptanceDigest,
  claimAcceptanceTypedData,
  claimAuthorizationDigest,
} from '../src/claims/claim.typed-data';
import {
  decryptIdentity,
  encryptIdentity,
  readIdentityKey,
} from '../src/identity/identity.crypto';
import { SessionService } from '../src/identity/session.service';

const depositAbi = parseAbi([
  'function deposit(bytes32 claimId, bytes32 commitment, uint256 amount)',
]);
const signatureAbi = parseAbi([
  'function signerEpoch() view returns (uint64)',
  'function authorizationDigest((bytes32 claimId,bytes32 identityCommitment,address token,uint256 amount,address recipient,uint256 nonce,uint64 deadline,uint64 signerEpoch) authorization) view returns (bytes32)',
  'function acceptanceDigest(bytes32 signedAuthorizationDigest) view returns (bytes32)',
]);
const payerAccount = privateKeyToAccount(
  `0x${randomBytes(32).toString('hex')}`,
);
const recipientAccount = privateKeyToAccount(
  `0x${randomBytes(32).toString('hex')}`,
);
const recipientAddress = recipientAccount.address.toLowerCase();

describe('claim preparation (Postgres and Anvil)', () => {
  let app: INestApplication<App>;
  const db = new PrismaClient();
  let payerId: string;
  let otherId: string;
  let firstClaimId: string;
  const payerAddress = payerAccount.address.toLowerCase();

  beforeAll(async () => {
    process.env.CHAIN_ID = '31337';
    const payer = await db.user.create({
      data: {
        privyDid: `did:privy:${randomUUID()}`,
        handle: `u_${randomBytes(6).toString('hex')}`,
      },
    });
    const other = await db.user.create({
      data: { privyDid: `did:privy:${randomUUID()}` },
    });
    payerId = payer.id;
    otherId = other.id;
    await db.account.create({
      data: {
        userId: otherId,
        chainId: 31337,
        settlementAddress: recipientAddress,
      },
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SessionService)
      .useValue({
        sync: jest.fn((token: string) =>
          Promise.resolve({
            id: token === 'other' ? otherId : payerId,
            handle: payer.handle,
            account: {
              chainId: 31337,
              address: token === 'other' ? recipientAddress : payerAddress,
            },
          }),
        ),
        recipientSnapshot: jest.fn(() =>
          Promise.resolve({
            userId: otherId,
            destination: `0x${'11'.repeat(20)}`,
          }),
        ),
      })
      .compile();
    app = module.createNestApplication();
    await app.init();

    const wallet = createWalletClient({
      chain: foundry,
      transport: http(process.env.RPC_URL),
    });
    const [sender] = await wallet.getAddresses();
    const hash = await wallet.writeContract({
      account: sender,
      address: process.env.SETTLEMENT_TOKEN as Address,
      abi: parseAbi(['function mint(address recipient, uint256 amount)']),
      functionName: 'mint',
      args: [payerAddress, 20_000_000n],
    });
    await createPublicClient({
      transport: http(process.env.RPC_URL),
    }).waitForTransactionReceipt({ hash });
    const gasHash = await wallet.sendTransaction({
      account: sender,
      to: payerAccount.address,
      value: 10n ** 18n,
    });
    await createPublicClient({
      transport: http(process.env.RPC_URL),
    }).waitForTransactionReceipt({ hash: gasHash });
  });

  afterAll(async () => {
    await db.identity.deleteMany({ where: { userId: otherId } });
    await db.claimAuthorization.deleteMany({ where: { claim: { payerId } } });
    await db.outboxJob.deleteMany({ where: { claim: { payerId } } });
    await db.transactionAttempt.deleteMany({ where: { intent: { payerId } } });
    await db.paymentIntent.deleteMany({ where: { payerId } });
    await db.claim.deleteMany({ where: { payerId } });
    await db.thread.deleteMany({
      where: { OR: [{ lowerUserId: payerId }, { upperUserId: payerId }] },
    });
    await db.account.deleteMany({ where: { userId: otherId } });
    await db.user.deleteMany({ where: { id: { in: [payerId, otherId] } } });
    await db.$disconnect();
    await app.close();
  });

  it('reserves once and exposes only exact wallet calls', async () => {
    const body = {
      recipientEmail: 'Name+tag@EXAMPLE.COM',
      amountUnits: '15000000',
    };
    await request(app.getHttpServer())
      .post('/v1/claims')
      .send(body)
      .expect(401);
    const created = await request(app.getHttpServer())
      .post('/v1/claims')
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'claim-one')
      .send(body)
      .expect(201);
    const claim = created.body as {
      id: `0x${string}`;
      state: string;
      plan: {
        approve: { to: string; data: `0x${string}` };
        deposit: { to: string; data: `0x${string}` };
      };
    };
    expect(claim.id).toMatch(/^0x[0-9a-f]{64}$/);
    firstClaimId = claim.id;
    expect(claim.state).toBe('AWAITING_DEPOSIT');
    expect(JSON.stringify(claim)).not.toContain('Name+tag');
    expect(claim.plan.approve.to.toLowerCase()).toBe(
      process.env.SETTLEMENT_TOKEN?.toLowerCase(),
    );
    expect(claim.plan.deposit.to.toLowerCase()).toBe(
      process.env.CLAIM_ESCROW_ADDRESS?.toLowerCase(),
    );
    const approval = decodeFunctionData({
      abi: erc20Abi,
      data: claim.plan.approve.data,
    });
    expect(approval.functionName).toBe('approve');
    expect(approval.args?.[0]?.toLowerCase()).toBe(
      process.env.CLAIM_ESCROW_ADDRESS?.toLowerCase(),
    );
    expect(approval.args?.[1]).toBe(15_000_000n);
    const deposit = decodeFunctionData({
      abi: depositAbi,
      data: claim.plan.deposit.data,
    });
    expect(deposit.functionName).toBe('deposit');
    expect(deposit.args?.[0]).toBe(claim.id);
    expect(deposit.args?.[2]).toBe(15_000_000n);

    const stored = await db.claim.findUniqueOrThrow({
      where: { id: claim.id },
    });
    expect(stored.identityCommitment).toBe(deposit.args?.[1]);
    expect(
      decryptIdentity(
        stored.encryptedRecipientEmail,
        readIdentityKey(process.env.IDENTITY_ENCRYPTION_KEY),
      ),
    ).toBe('Name+tag@example.com');
    expect(JSON.stringify(claim)).not.toContain(stored.inviteTokenHash);
    expect(JSON.stringify(claim)).not.toContain(stored.identityLookupKey);

    const replay = await request(app.getHttpServer())
      .post('/v1/claims')
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'claim-one')
      .send({ ...body, recipientEmail: 'Name+tag@example.com' })
      .expect(201);
    expect((replay.body as { id: string }).id).toBe(claim.id);
    await request(app.getHttpServer())
      .post('/v1/claims')
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'claim-one')
      .send({ ...body, amountUnits: '14000000' })
      .expect(409);
    await request(app.getHttpServer())
      .get(`/v1/claims/${claim.id}`)
      .set('privy-id-token', 'other')
      .expect(404);
    await request(app.getHttpServer())
      .post('/v1/claims')
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'claim-two')
      .send({ ...body, amountUnits: '6000000' })
      .expect(422);
    await request(app.getHttpServer())
      .post('/v1/payments')
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'send-after-claim')
      .send({
        recipientReference: randomBytes(32).toString('base64url'),
        amountUnits: '6000000',
      })
      .expect(422);

    const signer = createWalletClient({
      account: payerAccount,
      chain: foundry,
      transport: http(process.env.RPC_URL),
    });
    const approvalHash = await signer.sendTransaction({
      to: claim.plan.approve.to as Address,
      data: claim.plan.approve.data,
      value: 0n,
    });
    const client = createPublicClient({ transport: http(process.env.RPC_URL) });
    await client.waitForTransactionReceipt({ hash: approvalHash });
    await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/deposit`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'deposit-approval-only')
      .send({ txHash: approvalHash })
      .expect(409);
    expect(await db.outboxJob.count({ where: { claimId: claim.id } })).toBe(0);
    const depositHash = await signer.sendTransaction({
      to: claim.plan.deposit.to as Address,
      data: claim.plan.deposit.data,
      value: 0n,
    });
    await client.waitForTransactionReceipt({ hash: depositHash });
    const confirmed = await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/deposit`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'deposit-confirmed')
      .send({ txHash: depositHash })
      .expect(201);
    expect((confirmed.body as { state: string }).state).toBe('OPEN');
    expect((confirmed.body as { expiry: string }).expiry).toBeTruthy();
    expect((confirmed.body as { plan: unknown }).plan).toBeNull();
    const again = await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/deposit`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'deposit-confirmed')
      .send({ txHash: depositHash })
      .expect(201);
    expect((again.body as { state: string }).state).toBe('OPEN');
    await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/deposit`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'deposit-confirmed')
      .send({ txHash: `0x${'22'.repeat(32)}` })
      .expect(409);
    const saved = await db.claim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(saved.depositTxHash).toBe(depositHash);
    expect(saved.depositBlockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(saved.expiry).not.toBeNull();
    expect(await db.outboxJob.count({ where: { claimId: claim.id } })).toBe(2);
    const openActivity = await request(app.getHttpServer())
      .get('/v1/activity')
      .set('privy-id-token', 'payer')
      .expect(200);
    const openClaim = (
      openActivity.body as {
        items: { id: string; kind: string; state: string; txHash: string }[];
      }
    ).items.find((item) => item.kind === 'CLAIM');
    expect(openClaim).toMatchObject({ state: 'OPEN', txHash: depositHash });
    const recipientBeforeClaim = await request(app.getHttpServer())
      .get('/v1/activity')
      .set('privy-id-token', 'other')
      .expect(200);
    expect((recipientBeforeClaim.body as { items: unknown[] }).items).toEqual(
      [],
    );

    const originalFetch = global.fetch;
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation((input, init) =>
        input === 'https://api.resend.com/emails'
          ? Promise.resolve({ ok: true } as Response)
          : originalFetch(input, init),
      );
    const previousEmailKey = process.env.EMAIL_PROVIDER_KEY;
    const previousEmailFrom = process.env.EMAIL_FROM;
    process.env.EMAIL_PROVIDER_KEY = 'test-only-key';
    process.env.EMAIL_FROM = 'TEA <test@example.com>';
    try {
      expect(await processNextClaimInvite(db)).toBe(true);
      expect(await processNextClaimInvite(db)).toBe(false);
      const emailCalls = fetchMock.mock.calls.filter(
        ([input]) => input === 'https://api.resend.com/emails',
      );
      expect(emailCalls).toHaveLength(1);
      const payload = emailCalls[0][1]?.body;
      if (typeof payload !== 'string') throw new Error('Missing email body');
      const requestBody = JSON.parse(payload) as {
        to: string[];
        text: string;
      };
      expect(requestBody.to).toEqual(['Name+tag@example.com']);
      expect(requestBody.text).toContain('/claim/');
      expect(requestBody.text).not.toContain(saved.identityCommitment);
      expect(
        (
          await db.outboxJob.findFirstOrThrow({
            where: { claimId: claim.id, kind: 'CLAIM_INVITE' },
          })
        ).state,
      ).toBe('SENT');
      await request(app.getHttpServer())
        .post(`/v1/claims/${claim.id}/resend`)
        .set('Idempotency-Key', 'resend-one')
        .expect(401);
      await request(app.getHttpServer())
        .post(`/v1/claims/${claim.id}/resend`)
        .set('privy-id-token', 'other')
        .set('Idempotency-Key', 'resend-one')
        .expect(404);
      const resend = await request(app.getHttpServer())
        .post(`/v1/claims/${claim.id}/resend`)
        .set('privy-id-token', 'payer')
        .set('Idempotency-Key', 'resend-one')
        .expect(201);
      expect((resend.body as { state: string }).state).toBe('PENDING');
      await request(app.getHttpServer())
        .post(`/v1/claims/${claim.id}/resend`)
        .set('privy-id-token', 'payer')
        .set('Idempotency-Key', 'resend-one')
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/claims/${claim.id}/resend`)
        .set('privy-id-token', 'payer')
        .set('Idempotency-Key', 'resend-two')
        .expect(429);
      expect(await processNextClaimInvite(db)).toBe(true);
      expect(await processNextClaimInvite(db)).toBe(false);
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => input === 'https://api.resend.com/emails',
        ),
      ).toHaveLength(2);
    } finally {
      fetchMock.mockRestore();
      if (previousEmailKey === undefined) delete process.env.EMAIL_PROVIDER_KEY;
      else process.env.EMAIL_PROVIDER_KEY = previousEmailKey;
      if (previousEmailFrom === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = previousEmailFrom;
    }

    const signerEpoch = await client.readContract({
      address: saved.escrowAddress as Address,
      abi: signatureAbi,
      functionName: 'signerEpoch',
    });
    const authorization = {
      claimId: claim.id,
      identityCommitment: saved.identityCommitment as `0x${string}`,
      token: saved.tokenAddress as Address,
      amount: BigInt(saved.amountUnits.toString()),
      recipient: recipientAddress as Address,
      nonce: 0n,
      deadline: BigInt(Math.floor(saved.expiry!.getTime() / 1000) - 1),
      signerEpoch,
    };
    const backendDigest = claimAuthorizationDigest(
      saved.chainId,
      saved.escrowAddress as Address,
      authorization,
    );
    const onchainDigest = await client.readContract({
      address: saved.escrowAddress as Address,
      abi: signatureAbi,
      functionName: 'authorizationDigest',
      args: [authorization],
    });
    expect(backendDigest).toBe(onchainDigest);
    const backendAcceptance = claimAcceptanceDigest(
      saved.chainId,
      saved.escrowAddress as Address,
      backendDigest,
    );
    expect(backendAcceptance).toBe(
      await client.readContract({
        address: saved.escrowAddress as Address,
        abi: signatureAbi,
        functionName: 'acceptanceDigest',
        args: [backendDigest],
      }),
    );

    const encryptionKey = readIdentityKey(process.env.IDENTITY_ENCRYPTION_KEY);
    const inviteToken = decryptIdentity(
      saved.encryptedInviteToken,
      encryptionKey,
    );
    await request(app.getHttpServer())
      .post('/v1/claims/resolve-link')
      .send({ token: inviteToken })
      .expect(201, { requiresVerification: true });
    await request(app.getHttpServer())
      .post('/v1/claims/resolve-link')
      .set('privy-id-token', 'payer')
      .send({ token: inviteToken })
      .expect(404);
    await db.identity.create({
      data: {
        userId: otherId,
        kind: 'email',
        encryptedValue: Uint8Array.from(
          encryptIdentity('Name+tag@example.com', encryptionKey),
        ),
        lookupKey: saved.identityLookupKey,
        verifiedAt: new Date(),
      },
    });
    const invitation = await request(app.getHttpServer())
      .post('/v1/claims/resolve-link')
      .set('privy-id-token', 'other')
      .send({ token: inviteToken })
      .expect(201);
    expect((invitation.body as { id: string }).id).toBe(claim.id);
    expect((invitation.body as { state: string }).state).toBe('OPEN');
    expect(JSON.stringify(invitation.body)).not.toContain(inviteToken);

    await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/authorize`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'authorize-one')
      .send({ inviteToken })
      .expect(404);
    const authorized = await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/authorize`)
      .set('privy-id-token', 'other')
      .set('Idempotency-Key', 'authorize-one')
      .send({ inviteToken })
      .expect(201);
    const proof = authorized.body as {
      authorization: {
        claimId: `0x${string}`;
        identityCommitment: `0x${string}`;
        token: Address;
        amount: string;
        recipient: Address;
        nonce: string;
        deadline: string;
        signerEpoch: string;
      };
      authorizationDigest: `0x${string}`;
      identitySignature: `0x${string}`;
      acceptanceDigest: `0x${string}`;
    };
    expect(proof.authorization.recipient.toLowerCase()).toBe(recipientAddress);
    expect(proof.authorizationDigest).toBe(
      claimAuthorizationDigest(saved.chainId, saved.escrowAddress as Address, {
        claimId: proof.authorization.claimId,
        identityCommitment: proof.authorization.identityCommitment,
        token: proof.authorization.token,
        amount: BigInt(proof.authorization.amount),
        recipient: proof.authorization.recipient,
        nonce: BigInt(proof.authorization.nonce),
        deadline: BigInt(proof.authorization.deadline),
        signerEpoch: BigInt(proof.authorization.signerEpoch),
      }),
    );
    expect(proof.acceptanceDigest).toBe(
      claimAcceptanceDigest(
        saved.chainId,
        saved.escrowAddress as Address,
        proof.authorizationDigest,
      ),
    );
    const retry = await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/authorize`)
      .set('privy-id-token', 'other')
      .set('Idempotency-Key', 'authorize-one')
      .send({ inviteToken })
      .expect(201);
    expect(
      (retry.body as { identitySignature: string }).identitySignature,
    ).toBe(proof.identitySignature);
    const recipientSignature = await recipientAccount.signTypedData(
      claimAcceptanceTypedData(
        saved.chainId,
        saved.escrowAddress as Address,
        proof.authorizationDigest,
      ),
    );
    const acceptance = {
      inviteToken,
      authorizationDigest: proof.authorizationDigest,
      recipientSignature,
    };
    await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/submit`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'submit-one')
      .send(acceptance)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/submit`)
      .set('privy-id-token', 'other')
      .set('Idempotency-Key', 'submit-one')
      .send({
        ...acceptance,
        recipientSignature: await payerAccount.signTypedData(
          claimAcceptanceTypedData(
            saved.chainId,
            saved.escrowAddress as Address,
            proof.authorizationDigest,
          ),
        ),
      })
      .expect(400);
    const submitted = await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/submit`)
      .set('privy-id-token', 'other')
      .set('Idempotency-Key', 'submit-one')
      .send(acceptance)
      .expect(201);
    expect((submitted.body as { state: string }).state).toBe('PENDING');
    await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/submit`)
      .set('privy-id-token', 'other')
      .set('Idempotency-Key', 'submit-one')
      .send(acceptance)
      .expect(201);
    expect(await processNextClaimRelay(db)).toBe(true);
    const relayJob = await db.outboxJob.findFirstOrThrow({
      where: { claimId: claim.id, kind: 'CLAIM_RELAY' },
    });
    expect(relayJob.state).toBe('SUBMITTED');
    const claimHash = relayJob.txHash as `0x${string}`;
    expect(
      (await client.waitForTransactionReceipt({ hash: claimHash })).status,
    ).toBe('success');
    await db.outboxJob.update({
      where: { id: relayJob.id },
      data: { nextAttemptAt: new Date(0) },
    });
    expect(await processNextClaimRelay(db)).toBe(true);
    expect(await processNextClaimRelay(db)).toBe(false);
    expect(
      (await db.outboxJob.findUniqueOrThrow({ where: { id: relayJob.id } }))
        .state,
    ).toBe('SENT');
    const replayAfterSettlement = await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/submit`)
      .set('privy-id-token', 'other')
      .set('Idempotency-Key', 'submit-one')
      .send(acceptance)
      .expect(201);
    expect((replayAfterSettlement.body as { state: string }).state).toBe(
      'SENT',
    );
    expect(
      await client.readContract({
        address: saved.tokenAddress as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [recipientAccount.address],
      }),
    ).toBe(15_000_000n);
    const claimed = await request(app.getHttpServer())
      .post('/v1/claims/resolve-link')
      .set('privy-id-token', 'other')
      .send({ token: inviteToken })
      .expect(201);
    expect((claimed.body as { state: string }).state).toBe('CLAIMED');
    const payerView = await request(app.getHttpServer())
      .get(`/v1/claims/${claim.id}`)
      .set('privy-id-token', 'payer')
      .expect(200);
    expect((payerView.body as { state: string }).state).toBe('CLAIMED');
    const payerActivity = await request(app.getHttpServer())
      .get('/v1/activity')
      .set('privy-id-token', 'payer')
      .expect(200);
    expect((payerActivity.body as { items: unknown[] }).items).toContainEqual(
      expect.objectContaining({
        id: openClaim?.id,
        kind: 'CLAIM',
        direction: 'OUTGOING',
        state: 'CONFIRMED',
        txHash: claimHash,
      }),
    );
    const recipientActivity = await request(app.getHttpServer())
      .get('/v1/activity')
      .set('privy-id-token', 'other')
      .expect(200);
    expect(
      (recipientActivity.body as { items: unknown[] }).items,
    ).toContainEqual(
      expect.objectContaining({
        kind: 'CLAIM',
        direction: 'INCOMING',
        state: 'CONFIRMED',
        txHash: claimHash,
      }),
    );
    if (process.env.ENVIO_GRAPHQL_URL) {
      let receipt: { txHash: string } | null = null;
      for (let attempt = 0; attempt < 20 && !receipt; attempt++) {
        const activity = await request(app.getHttpServer())
          .get('/v1/activity')
          .set('privy-id-token', 'other')
          .expect(200);
        receipt =
          (
            activity.body as {
              items: {
                kind: string;
                indexedReceipt: { txHash: string } | null;
              }[];
            }
          ).items.find((item) => item.kind === 'CLAIM')?.indexedReceipt ?? null;
        if (!receipt) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(receipt?.txHash).toBe(claimHash);
    }
    await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/authorize`)
      .set('privy-id-token', 'other')
      .set('Idempotency-Key', 'authorize-two')
      .send({ inviteToken })
      .expect(409);
  });

  it('refunds only an expired open claim and cancels a claimed refund job', async () => {
    const prepared = await request(app.getHttpServer())
      .post('/v1/claims')
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'claim-refund-one')
      .send({ recipientEmail: 'refund@example.com', amountUnits: '2000000' })
      .expect(201);
    const claim = prepared.body as {
      id: string;
      plan: {
        approve: { to: Address; data: `0x${string}` };
        deposit: { to: Address; data: `0x${string}` };
      };
    };
    const signer = createWalletClient({
      account: payerAccount,
      chain: foundry,
      transport: http(process.env.RPC_URL),
    });
    const client = createPublicClient({ transport: http(process.env.RPC_URL) });
    const approvalHash = await signer.sendTransaction({
      to: claim.plan.approve.to,
      data: claim.plan.approve.data,
      value: 0n,
    });
    await client.waitForTransactionReceipt({ hash: approvalHash });
    const depositHash = await signer.sendTransaction({
      to: claim.plan.deposit.to,
      data: claim.plan.deposit.data,
      value: 0n,
    });
    await client.waitForTransactionReceipt({ hash: depositHash });
    const deposited = await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/deposit`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'refund-deposit-one')
      .send({ txHash: depositHash })
      .expect(201);
    expect((deposited.body as { state: string }).state).toBe('OPEN');
    expect(await processNextClaimRefund(db)).toBe(false);
    await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/refund`)
      .set('privy-id-token', 'other')
      .set('Idempotency-Key', 'request-refund')
      .expect(404);
    await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/refund`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'request-refund')
      .expect(409);

    const testClient = createTestClient({
      chain: foundry,
      mode: 'anvil',
      transport: http(process.env.RPC_URL),
    });
    await testClient.increaseTime({ seconds: 14 * 24 * 60 * 60 + 1 });
    await testClient.mine({ blocks: 1 });
    await db.outboxJob.updateMany({
      where: { kind: 'CLAIM_REFUND', claimId: firstClaimId },
      data: { nextAttemptAt: new Date(0) },
    });
    const requested = await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/refund`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'request-refund')
      .expect(201);
    expect((requested.body as { state: string }).state).toBe('QUEUED');
    await request(app.getHttpServer())
      .post(`/v1/claims/${claim.id}/refund`)
      .set('privy-id-token', 'payer')
      .set('Idempotency-Key', 'request-refund')
      .expect(201);
    expect(await processNextClaimRefund(db)).toBe(true);
    expect(
      (
        await db.outboxJob.findFirstOrThrow({
          where: { claimId: firstClaimId, kind: 'CLAIM_REFUND' },
        })
      ).state,
    ).toBe('CANCELED');
    expect(await processNextClaimRefund(db)).toBe(true);
    const refundJob = await db.outboxJob.findFirstOrThrow({
      where: { claimId: claim.id, kind: 'CLAIM_REFUND' },
    });
    expect(refundJob.state).toBe('SUBMITTED');
    expect(refundJob.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    await client.waitForTransactionReceipt({
      hash: refundJob.txHash as `0x${string}`,
    });
    await db.outboxJob.update({
      where: { id: refundJob.id },
      data: { nextAttemptAt: new Date(0) },
    });
    expect(await processNextClaimRefund(db)).toBe(true);
    expect(await processNextClaimRefund(db)).toBe(false);
    expect(
      (await db.outboxJob.findUniqueOrThrow({ where: { id: refundJob.id } }))
        .state,
    ).toBe('SENT');
    expect(
      (await db.claim.findUniqueOrThrow({ where: { id: claim.id } })).state,
    ).toBe('REFUNDED');
    const refundActivity = await request(app.getHttpServer())
      .get('/v1/activity')
      .set('privy-id-token', 'payer')
      .expect(200);
    expect((refundActivity.body as { items: unknown[] }).items).toContainEqual(
      expect.objectContaining({ kind: 'CLAIM', state: 'REFUNDED' }),
    );
    const payerView = await request(app.getHttpServer())
      .get(`/v1/claims/${claim.id}`)
      .set('privy-id-token', 'payer')
      .expect(200);
    expect((payerView.body as { state: string }).state).toBe('REFUNDED');
    expect(
      await client.readContract({
        address: process.env.SETTLEMENT_TOKEN as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [payerAccount.address],
      }),
    ).toBe(5_000_000n);
  });
});
