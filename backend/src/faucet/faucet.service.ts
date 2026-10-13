import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  Prisma,
  PrismaClient,
  type FaucetClaim,
  type GasGrant,
} from '@prisma/client';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import tokenAbiJson from '../abi/TestUSD.json';
import ausdFaucetAbiJson from '../abi/AusdFaucet.json';
import { SessionService } from '../identity/session.service';

const tokenAbi = tokenAbiJson as any;
const ausdFaucetAbi = ausdFaucetAbiJson as any;
const claimUnits = 10_000n * 1_000_000n;
const gasGrantWei = parseEther('0.1');
const gasMinimumWei = parseEther('0.02');

export function needsGasGrant(balance: bigint) {
  return balance < gasMinimumWei;
}

function utcClaimDay() {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

@Injectable()
export class FaucetService {
  private readonly db = new PrismaClient();

  constructor(private readonly sessions: SessionService) {}

  private config() {
    const rpcUrl = process.env.RPC_URL;
    const token = process.env.SETTLEMENT_TOKEN?.toLowerCase();
    const ausdToken = (
      process.env.AUSD_TOKEN ?? '0xa9012a055bd4e0edff8ce09f960291c09d5322dc'
    ).toLowerCase();
    const ausdFaucet =
      process.env.AUSD_FAUCET_ADDRESS ??
      '0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C';
    const chainId = Number(process.env.CHAIN_ID);
    const key =
      process.env.FAUCET_PRIVATE_KEY ?? process.env.RELAYER_PRIVATE_KEY;
    if (
      !rpcUrl ||
      !token ||
      !isAddress(token) ||
      !isAddress(ausdToken) ||
      !isAddress(ausdFaucet) ||
      !Number.isSafeInteger(chainId) ||
      !key ||
      !/^0x[0-9a-fA-F]{64}$/.test(key)
    ) {
      throw new ServiceUnavailableException('Faucet is not configured');
    }
    return { rpcUrl, token, ausdToken, ausdFaucet, chainId, key: key as Hex };
  }

  private async reserveClaim(
    userId: string,
    chainId: number,
    tokenAddress: string,
    walletAddress: string,
    claimDay: Date,
  ) {
    const existing = await this.db.faucetClaim.findUnique({
      where: {
        chainId_tokenAddress_walletAddress_claimDay: {
          chainId,
          tokenAddress,
          walletAddress,
          claimDay,
        },
      },
    });
    if (existing?.state === 'CONFIRMED' || existing?.state === 'PENDING') {
      throw new ConflictException('Faucet already claimed today');
    }
    if (existing) {
      return this.db.faucetClaim.update({
        where: { id: existing.id },
        data: { state: 'PENDING', txHash: null, blockNumber: null },
      });
    }
    try {
      return await this.db.faucetClaim.create({
        data: {
          userId,
          chainId,
          tokenAddress,
          walletAddress,
          claimDay,
          amountUnits: new Prisma.Decimal(claimUnits.toString()),
          state: 'PENDING',
        },
      });
    } catch (cause) {
      if (
        cause instanceof Prisma.PrismaClientKnownRequestError &&
        cause.code === 'P2002'
      ) {
        throw new ConflictException('Faucet already claimed today');
      }
      throw cause;
    }
  }

  private async reserveGasGrant(
    userId: string,
    chainId: number,
    walletAddress: string,
    grantDay: Date,
  ) {
    const existing = await this.db.gasGrant.findUnique({
      where: {
        chainId_walletAddress_grantDay: {
          chainId,
          walletAddress,
          grantDay,
        },
      },
    });
    if (existing?.state === 'CONFIRMED' || existing?.state === 'PENDING') {
      throw new ConflictException('Daily testnet gas allowance already used');
    }
    if (existing) {
      return this.db.gasGrant.update({
        where: { id: existing.id },
        data: { state: 'PENDING', txHash: null, blockNumber: null },
      });
    }
    try {
      return await this.db.gasGrant.create({
        data: {
          userId,
          chainId,
          walletAddress,
          grantDay,
          amountWei: new Prisma.Decimal(gasGrantWei.toString()),
          state: 'PENDING',
        },
      });
    } catch (cause) {
      if (
        cause instanceof Prisma.PrismaClientKnownRequestError &&
        cause.code === 'P2002'
      ) {
        throw new ConflictException('Daily testnet gas allowance already used');
      }
      throw cause;
    }
  }

  async gas(identityToken: string | undefined) {
    if (!identityToken)
      throw new UnauthorizedException('Session token required');
    const user = await this.sessions.sync(identityToken);
    const { rpcUrl, chainId, key } = this.config();
    if (user.account.chainId !== chainId)
      throw new ServiceUnavailableException('Wrong faucet chain');

    const chain = defineChain({
      id: chainId,
      name: 'TEA settlement',
      nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, { timeout: 10_000 }),
    });
    const address = user.account.address as Address;
    const balance = await publicClient.getBalance({ address });
    if (!needsGasGrant(balance)) {
      return { amountWei: '0', chainId, txHash: null };
    }

    let grant: GasGrant | undefined;
    let submitted = false;
    try {
      grant = await this.reserveGasGrant(
        user.id,
        chainId,
        address.toLowerCase(),
        utcClaimDay(),
      );
      const wallet = createWalletClient({
        account: privateKeyToAccount(key),
        chain,
        transport: http(rpcUrl, { timeout: 10_000 }),
      });
      const txHash = await wallet.sendTransaction({
        to: address,
        value: gasGrantWei,
      });
      await this.db.gasGrant.update({
        where: { id: grant.id },
        data: { txHash },
      });
      submitted = true;
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60_000,
      });
      if (receipt.status !== 'success') throw new Error('Gas grant failed');
      await this.db.gasGrant.update({
        where: { id: grant.id },
        data: { state: 'CONFIRMED', blockNumber: receipt.blockNumber },
      });
      return { amountWei: gasGrantWei.toString(), chainId, txHash };
    } catch (cause) {
      if (grant && !submitted) {
        await this.db.gasGrant
          .update({ where: { id: grant.id }, data: { state: 'FAILED' } })
          .catch(() => undefined);
      }
      throw cause;
    }
  }

  async claim(identityToken: string | undefined, input: unknown) {
    if (!identityToken)
      throw new UnauthorizedException('Session token required');
    const user = await this.sessions.sync(identityToken);
    const {
      rpcUrl,
      token: testToken,
      ausdToken,
      ausdFaucet,
      chainId,
      key,
    } = this.config();
    const requested =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>).token
        : undefined;
    if (typeof requested !== 'string' || !isAddress(requested))
      throw new ServiceUnavailableException('Faucet token is invalid');
    const token = requested.toLowerCase();
    if (token !== testToken && token !== ausdToken)
      throw new ServiceUnavailableException('Faucet token is not supported');
    if (user.account.chainId !== chainId)
      throw new ServiceUnavailableException('Wrong faucet chain');

    let claim: FaucetClaim | undefined;
    let submitted = false;
    try {
      claim = await this.reserveClaim(
        user.id,
        chainId,
        token,
        user.account.address.toLowerCase(),
        utcClaimDay(),
      );
      const chain = defineChain({
        id: chainId,
        name: 'TEA settlement',
        nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      });
      const wallet = createWalletClient({
        account: privateKeyToAccount(key),
        chain,
        transport: http(rpcUrl, { timeout: 10_000 }),
      });
      const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl, { timeout: 10_000 }),
      });
      const txHash =
        token === ausdToken
          ? await wallet.writeContract({
              address: ausdFaucet as Address,
              abi: ausdFaucetAbi,
              functionName: 'requestFunds',
              args: [user.account.address as Address],
            })
          : await wallet.writeContract({
              address: token as Address,
              abi: tokenAbi,
              functionName: 'mint',
              args: [user.account.address as Address, claimUnits],
            });
      await this.db.faucetClaim.update({
        where: { id: claim.id },
        data: { txHash },
      });
      submitted = true;
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60_000,
      });
      if (receipt.status !== 'success') throw new Error('Faucet mint failed');
      await this.db.faucetClaim.update({
        where: { id: claim.id },
        data: { state: 'CONFIRMED', blockNumber: receipt.blockNumber },
      });
      return { amountUnits: claimUnits.toString(), token, chainId, txHash };
    } catch (cause) {
      if (claim && !submitted) {
        await this.db.faucetClaim
          .update({ where: { id: claim.id }, data: { state: 'FAILED' } })
          .catch(() => undefined);
      }
      throw cause;
    }
  }
}
