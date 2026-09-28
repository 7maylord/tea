import {
  ConflictException,
  BadRequestException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import type { LinkedAccount, User } from '@privy-io/node';
import { createClient } from 'redis';
import {
  encryptIdentity,
  identityKey,
  normalizeEmail,
  NORMALIZATION_VERSION,
  readIdentityKey,
} from './identity.crypto';

@Injectable()
export class SessionService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionService.name);
  private readonly db = new PrismaClient();
  private getUser?: (token: string) => Promise<User>;
  private getCurrentUser?: (did: string) => Promise<User>;
  private redis?: ReturnType<typeof createClient>;
  private connecting?: Promise<void>;

  async onModuleDestroy() {
    await this.db.$disconnect();
    if (this.redis?.isOpen) await this.redis.quit();
  }

  private async verifiedUser(token: string) {
    const { PRIVY_APP_ID, PRIVY_APP_SECRET } = process.env;
    if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
      throw new ServiceUnavailableException(
        'Identity provider is not configured',
      );
    }
    if (!this.getUser) {
      const { PrivyClient } = await import('@privy-io/node');
      const client = new PrivyClient({
        appId: PRIVY_APP_ID,
        appSecret: PRIVY_APP_SECRET,
      });
      this.getUser = async (accessToken) => {
        let userId: string;
        try {
          const session = await client
            .utils()
            .auth()
            .verifyAccessToken(accessToken);
          userId = session.user_id;
        } catch {
          throw new UnauthorizedException('Invalid session token');
        }
        try {
          return await client.users()._get(userId);
        } catch {
          throw new ServiceUnavailableException(
            'Identity provider unavailable',
          );
        }
      };
      this.getCurrentUser = (did) => client.users()._get(did);
    }
    return this.getUser(token);
  }

  private async currentProviderUser(did: string): Promise<User> {
    try {
      if (!this.getCurrentUser) throw new Error('Privy client unavailable');
      return await this.getCurrentUser(did);
    } catch {
      throw new ServiceUnavailableException('Identity provider unavailable');
    }
  }

  private async cache() {
    const url = process.env.REDIS_URL;
    if (!url)
      throw new ServiceUnavailableException('Recipient lookup unavailable');
    if (!this.redis) {
      try {
        this.redis = createClient({
          url,
          socket: { reconnectStrategy: false, connectTimeout: 3000 },
        });
      } catch {
        throw new ServiceUnavailableException('Recipient lookup unavailable');
      }
      this.redis.on('error', () =>
        this.logger.error('Recipient lookup Redis connection error'),
      );
    }
    if (!this.redis.isOpen) {
      this.connecting ??= this.redis
        .connect()
        .then(() => undefined)
        .finally(() => {
          this.connecting = undefined;
        });
    }
    try {
      await this.connecting;
      return this.redis;
    } catch {
      this.connecting = undefined;
      throw new ServiceUnavailableException('Recipient lookup unavailable');
    }
  }

  async sync(token: string | undefined) {
    if (!token) throw new UnauthorizedException('Session token required');
    if (!process.env.DATABASE_URL) {
      throw new ServiceUnavailableException('Database is not configured');
    }
    let lookupSecret: Buffer;
    let encryptionSecret: Buffer;
    try {
      lookupSecret = readIdentityKey(process.env.IDENTITY_LOOKUP_HMAC_KEY);
      encryptionSecret = readIdentityKey(process.env.IDENTITY_ENCRYPTION_KEY);
    } catch {
      throw new ServiceUnavailableException(
        'Identity storage is not configured',
      );
    }

    const providerUser = await this.verifiedUser(token);
    const emails = providerUser.linked_accounts.filter(
      (account): account is Extract<LinkedAccount, { type: 'email' }> =>
        account.type === 'email' && account.verified_at > 0,
    );
    const wallets = providerUser.linked_accounts.filter(
      (
        account,
      ): account is Extract<
        LinkedAccount,
        { wallet_client_type: 'privy'; chain_type: 'ethereum' }
      > =>
        account.type === 'wallet' &&
        account.wallet_client_type === 'privy' &&
        account.connector_type === 'embedded' &&
        account.chain_type === 'ethereum' &&
        account.verified_at > 0,
    );
    if (providerUser.is_guest || emails.length !== 1 || wallets.length !== 1) {
      throw new UnprocessableEntityException(
        'Verified email and wallet required',
      );
    }

    let email: string;
    try {
      email = normalizeEmail(emails[0].address);
    } catch {
      throw new UnprocessableEntityException('Invalid verified email');
    }
    const address = wallets[0].address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      throw new UnprocessableEntityException('Invalid embedded wallet');
    }
    const chainId = Number(process.env.CHAIN_ID);
    if (
      !Number.isSafeInteger(chainId) ||
      chainId <= 0 ||
      chainId > 2147483647
    ) {
      throw new ServiceUnavailableException('Chain is not configured');
    }

    const lookupKey = identityKey(email, lookupSecret);
    const encryptedValue = Uint8Array.from(
      encryptIdentity(email, encryptionSecret),
    );
    return this.db.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { privyDid: providerUser.id },
        create: { privyDid: providerUser.id },
        update: {},
      });
      await tx.identity.deleteMany({
        where: {
          userId: user.id,
          kind: 'email',
          lookupKey: { not: lookupKey },
        },
      });
      await tx.identity.createMany({
        data: {
          userId: user.id,
          kind: 'email',
          lookupKey,
          encryptedValue,
          normalizationVersion: NORMALIZATION_VERSION,
          verifiedAt: new Date(emails[0].verified_at * 1000),
        },
        skipDuplicates: true,
      });
      const identity = await tx.identity.findUnique({
        where: { kind_lookupKey: { kind: 'email', lookupKey } },
      });
      if (identity?.userId !== user.id) {
        throw new ConflictException('Verified email is already linked');
      }
      await tx.account.createMany({
        data: { userId: user.id, chainId, settlementAddress: address },
        skipDuplicates: true,
      });
      const account = await tx.account.findUnique({
        where: { userId_chainId: { userId: user.id, chainId } },
      });
      if (account?.settlementAddress !== address) {
        throw new ConflictException('Settlement wallet changed');
      }
      return {
        id: user.id,
        handle: user.handle,
        account: { chainId, address },
      };
    });
  }

  async reserveHandle(token: string | undefined, value: unknown) {
    if (!token) throw new UnauthorizedException('Session token required');
    if (
      typeof value !== 'string' ||
      !/^[a-z0-9_]{3,20}$/.test(value) ||
      ['tea', 'admin', 'support'].includes(value)
    ) {
      throw new BadRequestException('Invalid handle');
    }
    const user = await this.sync(token);
    try {
      await this.db.user.updateMany({
        where: { id: user.id, handle: null },
        data: { handle: value },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Handle is taken');
      }
      throw error;
    }
    const current = await this.db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { handle: true },
    });
    if (current.handle !== value) {
      throw new ConflictException('Handle cannot be changed');
    }
    return { handle: value };
  }

  async resolve(token: string | undefined, kind: unknown, value: unknown) {
    if (!token) throw new UnauthorizedException('Session token required');
    if (kind !== 'handle' && kind !== 'email') {
      throw new BadRequestException('Invalid recipient type');
    }
    if (typeof value !== 'string' || value.length > 254) {
      throw new BadRequestException('Invalid recipient');
    }
    if (kind === 'handle' && !/^[a-z0-9_]{3,20}$/.test(value)) {
      throw new BadRequestException('Invalid handle');
    }
    let normalized: string | undefined;
    if (kind === 'email') {
      try {
        normalized = normalizeEmail(value);
      } catch {
        throw new BadRequestException('Invalid email');
      }
    }

    const requester = await this.sync(token);
    if (!requester.handle) {
      throw new ConflictException('Handle required before sending');
    }
    const redis = await this.cache();
    const quotaKey = `tea:resolve:${requester.id}:${Math.floor(Date.now() / 60000)}`;
    let count: number;
    try {
      const result = await redis
        .multi()
        .incr(quotaKey)
        .expire(quotaKey, 120)
        .exec();
      if (typeof result[0] !== 'number') throw new Error('Invalid quota count');
      count = result[0];
    } catch {
      throw new ServiceUnavailableException('Recipient lookup unavailable');
    }
    if (count > 20)
      throw new HttpException(
        'Recipient lookup limit reached',
        HttpStatus.TOO_MANY_REQUESTS,
      );

    const lookupSecret = readIdentityKey(process.env.IDENTITY_LOOKUP_HMAC_KEY);
    const lookupKey = normalized
      ? identityKey(normalized, lookupSecret)
      : undefined;
    const target = lookupKey
      ? (
          await this.db.identity.findUnique({
            where: { kind_lookupKey: { kind: 'email', lookupKey } },
            include: { user: true },
          })
        )?.user
      : await this.db.user.findUnique({ where: { handle: value } });
    if (!target) {
      if (kind === 'email') return { kind: 'unregistered' };
      throw new NotFoundException('Recipient not found');
    }

    const account = await this.db.account.findUnique({
      where: {
        userId_chainId: {
          userId: target.id,
          chainId: requester.account.chainId,
        },
      },
    });
    if (!account) {
      if (kind === 'email') return { kind: 'unregistered' };
      throw new NotFoundException('Recipient not found');
    }
    const storedIdentity = await this.db.identity.findFirst({
      where: { userId: target.id, kind: 'email' },
    });
    const expectedEmailKey = lookupKey ?? storedIdentity?.lookupKey;
    const current = await this.currentProviderUser(target.privyDid);
    const emailStillLinked =
      !!expectedEmailKey &&
      current.linked_accounts.some((linked) => {
        if (linked.type !== 'email' || linked.verified_at <= 0) return false;
        try {
          return (
            identityKey(normalizeEmail(linked.address), lookupSecret) ===
            expectedEmailKey
          );
        } catch {
          return false;
        }
      });
    const walletStillLinked = current.linked_accounts.some(
      (linked) =>
        linked.type === 'wallet' &&
        linked.wallet_client_type === 'privy' &&
        linked.connector_type === 'embedded' &&
        linked.chain_type === 'ethereum' &&
        linked.verified_at > 0 &&
        linked.address.toLowerCase() === account.settlementAddress,
    );
    if (current.is_guest || !emailStillLinked || !walletStillLinked) {
      if (kind === 'email') return { kind: 'unregistered' };
      throw new NotFoundException('Recipient not found');
    }

    const reference = randomBytes(32).toString('base64url');
    const refKey = `tea:recipient:${createHash('sha256').update(reference).digest('hex')}`;
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    try {
      const stored = await redis.set(
        refKey,
        JSON.stringify({
          requesterId: requester.id,
          userId: target.id,
          chainId: requester.account.chainId,
          destination: account.settlementAddress,
          expiresAt,
        }),
        { EX: 300, NX: true },
      );
      if (stored !== 'OK') throw new Error('Reference collision');
    } catch {
      throw new ServiceUnavailableException('Recipient lookup unavailable');
    }
    return {
      kind: 'existing',
      recipient: { handle: target.handle, displayName: target.displayName },
      reference,
      expiresAt,
    };
  }

  async recipientSnapshot(
    reference: string,
    requesterId: string,
    chainId: number,
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(reference)) {
      throw new BadRequestException('Invalid recipient reference');
    }
    const key = `tea:recipient:${createHash('sha256').update(reference).digest('hex')}`;
    let raw: string | null;
    try {
      raw = await (await this.cache()).get(key);
    } catch {
      throw new ServiceUnavailableException('Recipient lookup unavailable');
    }
    if (!raw) throw new GoneException('Recipient reference expired');
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(raw) as unknown;
    } catch {
      throw new ServiceUnavailableException('Recipient lookup unavailable');
    }
    if (!snapshot || typeof snapshot !== 'object') {
      throw new ServiceUnavailableException('Recipient lookup unavailable');
    }
    const item = snapshot as Record<string, unknown>;
    if (
      item.requesterId !== requesterId ||
      item.chainId !== chainId ||
      typeof item.userId !== 'string' ||
      typeof item.destination !== 'string' ||
      !/^0x[0-9a-f]{40}$/.test(item.destination) ||
      typeof item.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(item.expiresAt)) ||
      Date.parse(item.expiresAt) <= Date.now()
    ) {
      throw new GoneException('Recipient reference expired');
    }
    return { userId: item.userId, destination: item.destination };
  }
}
