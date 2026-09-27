import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createPublicClient as createPublicClientBase,
  http,
  isAddress,
  type Address,
} from 'viem';
import tokenAbiJson from '../abi/TestUSD.json';
import { SessionService } from '../identity/session.service';

const tokenAbi = tokenAbiJson as any;
const createPublicClient = createPublicClientBase as any;

@Injectable()
export class FundsService {
  constructor(private readonly sessions: SessionService) {}

  private config() {
    const rpcUrl = process.env.RPC_URL;
    const token = process.env.SETTLEMENT_TOKEN;
    const chainId = Number(process.env.CHAIN_ID);
    if (
      !rpcUrl ||
      !token ||
      !isAddress(token) ||
      !Number.isSafeInteger(chainId)
    ) {
      throw new ServiceUnavailableException(
        'Settlement network is not configured',
      );
    }
    return { rpcUrl, token, chainId };
  }

  async balance(identityToken: string | undefined) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    const user = await this.sessions.sync(identityToken);
    return this.readBalance(user.account);
  }

  async readBalance(account: { chainId: number; address: string }) {
    const { rpcUrl, token, chainId } = this.config();
    const client = createPublicClient({
      transport: http(rpcUrl, { timeout: 5000 }),
    });
    try {
      if (
        (await client.getChainId()) !== chainId ||
        account.chainId !== chainId
      ) {
        throw new Error('Wrong chain');
      }
      const blockNumber = await client.getBlockNumber();
      const [units, decimals, symbol] = await Promise.all([
        client.readContract({
          address: token,
          abi: tokenAbi,
          functionName: 'balanceOf',
          args: [account.address as Address],
          blockNumber,
        }),
        client.readContract({
          address: token,
          abi: tokenAbi,
          functionName: 'decimals',
          blockNumber,
        }),
        client.readContract({
          address: token,
          abi: tokenAbi,
          functionName: 'symbol',
          blockNumber,
        }),
      ]);
      return {
        chainId,
        token,
        symbol,
        decimals,
        balanceUnits: units.toString(),
        blockNumber: blockNumber.toString(),
      };
    } catch {
      throw new ServiceUnavailableException(
        'Balance is temporarily unavailable',
      );
    }
  }
}
