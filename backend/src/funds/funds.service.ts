import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  isAddress,
  parseAbi,
  type Address,
} from 'viem';
import { foundry } from 'viem/chains';
import { SessionService } from '../identity/session.service';

const faucetAbi = parseAbi([
  'function mint(address recipient, uint256 amount)',
]);

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
    const { rpcUrl, token, chainId } = this.config();
    const client = createPublicClient({
      transport: http(rpcUrl, { timeout: 5000 }),
    });
    try {
      if (
        (await client.getChainId()) !== chainId ||
        user.account.chainId !== chainId
      ) {
        throw new Error('Wrong chain');
      }
      const blockNumber = await client.getBlockNumber();
      const [units, decimals, symbol] = await Promise.all([
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [user.account.address as Address],
          blockNumber,
        }),
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'decimals',
          blockNumber,
        }),
        client.readContract({
          address: token,
          abi: erc20Abi,
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

  async localFaucet(identityToken: string | undefined) {
    if (!identityToken)
      throw new UnauthorizedException('Identity token required');
    if (process.env.APP_ENV !== 'local' || process.env.CHAIN_ID !== '31337') {
      throw new NotFoundException();
    }
    const { rpcUrl, token } = this.config();
    let url: URL;
    try {
      url = new URL(rpcUrl);
    } catch {
      throw new NotFoundException();
    }
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname)
    ) {
      throw new NotFoundException();
    }
    const user = await this.sessions.sync(identityToken);
    if (!user.handle || user.account.chainId !== 31337) {
      throw new ServiceUnavailableException('Local account is not ready');
    }
    const publicClient = createPublicClient({
      chain: foundry,
      transport: http(rpcUrl, { timeout: 5000 }),
    });
    try {
      if ((await publicClient.getChainId()) !== 31337)
        throw new Error('Wrong chain');
      const [name, decimals] = await Promise.all([
        publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'name',
        }),
        publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'decimals',
        }),
      ]);
      if (name !== 'Test USD (no cash value)' || decimals !== 6) {
        throw new Error('Wrong faucet token');
      }
      const wallet = createWalletClient({
        chain: foundry,
        transport: http(rpcUrl, { timeout: 5000 }),
      });
      const [sender] = await wallet.getAddresses();
      if (!sender) throw new Error('No unlocked local account');
      const hash = await wallet.writeContract({
        account: sender,
        address: token,
        abi: faucetAbi,
        functionName: 'mint',
        args: [user.account.address as Address, 20_000_000n],
      });
      return { status: 'submitted', hash };
    } catch {
      throw new ServiceUnavailableException('Local faucet is unavailable');
    }
  }
}
