import {
  ConflictException,
  BadRequestException,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { LinkedAccount, User } from '@privy-io/node';
import {
  encryptIdentity,
  identityKey,
  normalizeEmail,
  NORMALIZATION_VERSION,
  readIdentityKey,
} from './identity.crypto';

@Injectable()
export class SessionService implements OnModuleDestroy {
  private readonly db = new PrismaClient();
  private getUser?: (token: string) => Promise<User>;

  async onModuleDestroy() {
    await this.db.$disconnect();
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
      this.getUser = async (idToken) => {
        let authenticated: User;
        try {
          authenticated = await client.users().get({ id_token: idToken });
        } catch {
          throw new UnauthorizedException('Invalid identity token');
        }
        try {
          return await client.users()._get(authenticated.id);
        } catch {
          throw new ServiceUnavailableException(
            'Identity provider unavailable',
          );
        }
      };
    }
    return this.getUser(token);
  }

  async sync(token: string | undefined) {
    if (!token) throw new UnauthorizedException('Identity token required');
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
    if (!token) throw new UnauthorizedException('Identity token required');
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
}
