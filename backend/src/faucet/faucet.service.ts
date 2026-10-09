import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, PrismaClient, type FaucetClaim } from '@prisma/client';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import tokenAbiJson from '../abi/TestUSD.json';
import { SessionService } from '../identity/session.service';

const tokenAbi = tokenAbiJson as any;
const claimUnits = 10_000n * 1_000_000n;

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
    const token = process.env.SETTLEMENT_TOKEN;
    const chainId = Number(process.env.CHAIN_ID);
    const key =
      process.env.FAUCET_PRIVATE_KEY ?? process.env.RELAYER_PRIVATE_KEY;
    if (
      !rpcUrl ||
      !token ||
      !isAddress(token) ||
      !Number.isSafeInteger(chainId) ||
      !key ||
      !/^0x[0-9a-fA-F]{64}$/.test(key)
    ) {
      throw new ServiceUnavailableException('Faucet is not configured');
    }
    return { rpcUrl, token, chainId, key: key as Hex };
  }

  private async reserveClaim(
    userId: string,
    chainId: number,
    walletAddress: string,
    claimDay: Date,
  ) {
    const existing = await this.db.faucetClaim.findUnique({
      where: {
        chainId_walletAddress_claimDay: { chainId, walletAddress, claimDay },
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

  async claim(identityToken: string | undefined) {
    if (!identityToken)
      throw new UnauthorizedException('Session token required');
    const user = await this.sessions.sync(identityToken);
    const { rpcUrl, token, chainId, key } = this.config();
    if (user.account.chainId !== chainId)
      throw new ServiceUnavailableException('Wrong faucet chain');

    let claim: FaucetClaim | undefined;
    let submitted = false;
    try {
      claim = await this.reserveClaim(
        user.id,
        chainId,
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
      const txHash = await wallet.writeContract({
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
