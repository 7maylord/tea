import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  createPublicClient,
  erc20Abi,
  http,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/identity/session.service';

const recipient = `0x${randomBytes(20).toString('hex')}`;
const injectedRecipient = '0x000000000000000000000000000000000000dEaD';

describe('local test funds (Anvil)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    process.env.APP_ENV = 'local';
    process.env.CHAIN_ID = '31337';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SessionService)
      .useValue({
        sync: jest.fn(() =>
          Promise.resolve({
            id: 'local-test-user',
            handle: 'local_user',
            account: { chainId: 31337, address: recipient },
          }),
        ),
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('funds only the authenticated account with local token and gas', async () => {
    await request(app.getHttpServer()).get('/v1/balance').expect(401);
    await request(app.getHttpServer()).post('/v1/local/faucet').expect(401);

    const before = await request(app.getHttpServer())
      .get('/v1/balance')
      .set('privy-id-token', 'mocked-verified-token')
      .expect(200);
    const first = before.body as {
      balanceUnits: string;
      decimals: number;
      symbol: string;
    };
    expect(first.decimals).toBe(6);
    expect(first.symbol).toBe('TUSD');
    const client = createPublicClient({ transport: http(process.env.RPC_URL) });
    const gasBefore = await client.getBalance({
      address: recipient as Address,
    });
    const injectedGasBefore = await client.getBalance({
      address: injectedRecipient,
    });
    const injectedBefore = await client.readContract({
      address: process.env.SETTLEMENT_TOKEN as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [injectedRecipient],
    });

    process.env.APP_ENV = 'production';
    await request(app.getHttpServer())
      .post('/v1/local/faucet')
      .set('privy-id-token', 'mocked-verified-token')
      .expect(404);
    process.env.APP_ENV = 'local';

    const result = await request(app.getHttpServer())
      .post('/v1/local/faucet')
      .set('privy-id-token', 'mocked-verified-token')
      .send({
        recipient: injectedRecipient,
        amount: '999999',
      })
      .expect(201);
    const submitted = result.body as { status: string; hash: Hex };
    expect(submitted.status).toBe('submitted');
    const receipt = await client.waitForTransactionReceipt({
      hash: submitted.hash,
      timeout: 10000,
    });
    expect(receipt.status).toBe('success');
    const gasAfter = await client.getBalance({ address: recipient as Address });
    expect(gasAfter).toBeGreaterThanOrEqual(parseEther('0.01'));
    expect(gasAfter).toBeGreaterThan(gasBefore);
    expect(await client.getBalance({ address: injectedRecipient })).toBe(
      injectedGasBefore,
    );

    const after = await request(app.getHttpServer())
      .get('/v1/balance')
      .set('privy-id-token', 'mocked-verified-token')
      .expect(200);
    expect(
      BigInt((after.body as { balanceUnits: string }).balanceUnits) -
        BigInt(first.balanceUnits),
    ).toBe(20_000_000n);
    expect(
      await client.readContract({
        address: process.env.SETTLEMENT_TOKEN as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [injectedRecipient],
      }),
    ).toBe(injectedBefore);
  });
});
