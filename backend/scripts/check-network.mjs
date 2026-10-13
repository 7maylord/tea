import {
  createPublicClient,
  http,
  isAddress,
  keccak256,
} from 'viem';
import tokenAbi from '../src/abi/TestUSD.json' with { type: 'json' };
import streamAbi from '../src/abi/TeaStream.json' with { type: 'json' };
import escrowAbi from '../src/abi/TeaClaimEscrow.json' with { type: 'json' };
import dateUnlockAbi from '../src/abi/TeaDateUnlock.json' with { type: 'json' };
import monad from '../src/abi/monad-testnet.json' with { type: 'json' };

const env = {
  rpcUrl: process.env.RPC_URL,
  chainId: Number(process.env.CHAIN_ID ?? monad.chainId),
  token: process.env.SETTLEMENT_TOKEN ?? monad.settlementToken,
  decimals: Number(process.env.SETTLEMENT_TOKEN_DECIMALS ?? 6),
  stream: process.env.TEA_STREAM_ADDRESS ?? monad.teaStream,
  escrow: process.env.CLAIM_ESCROW_ADDRESS ?? monad.teaClaimEscrow,
  dateUnlock: process.env.TEA_DATE_UNLOCK_ADDRESS ?? monad.teaDateUnlock,
};

if (
  !env.rpcUrl ||
  !Number.isSafeInteger(env.chainId) ||
  env.chainId <= 0 ||
  !Number.isInteger(env.decimals) ||
  env.decimals < 0 ||
  env.decimals > 255 ||
  ![env.token, env.stream, env.escrow, env.dateUnlock].every((address) =>
    isAddress(address ?? ''),
  )
) {
  throw new Error(
    'Set RPC_URL, CHAIN_ID, SETTLEMENT_TOKEN, SETTLEMENT_TOKEN_DECIMALS, TEA_STREAM_ADDRESS, CLAIM_ESCROW_ADDRESS and TEA_DATE_UNLOCK_ADDRESS',
  );
}

const client = createPublicClient({
  transport: http(env.rpcUrl, { timeout: 5000 }),
});
const chainId = await client.getChainId();
if (chainId !== env.chainId) {
  throw new Error(`Wrong chain: expected ${env.chainId}, received ${chainId}`);
}

const blockNumber = await client.getBlockNumber();
async function codeHash(address, label) {
  const code = await client.getBytecode({ address, blockNumber });
  if (!code || code === '0x') throw new Error(`${label} has no bytecode`);
  return keccak256(code);
}

const [name, symbol, decimals] = await Promise.all(
  ['name', 'symbol', 'decimals'].map((functionName) =>
    client.readContract({
      address: env.token,
      abi: tokenAbi,
      functionName,
      blockNumber,
    }),
  ),
);
if (decimals !== env.decimals) {
  throw new Error(`Wrong decimals: expected ${env.decimals}, received ${decimals}`);
}

const support = await Promise.all([
  client.readContract({
    address: env.stream,
    abi: streamAbi,
    functionName: 'supportedTokens',
    args: [env.token],
    blockNumber,
  }),
  client.readContract({
    address: env.escrow,
    abi: escrowAbi,
    functionName: 'supportedTokens',
    args: [env.token],
    blockNumber,
  }),
  client.readContract({
    address: env.dateUnlock,
    abi: dateUnlockAbi,
    functionName: 'supportedTokens',
    args: [env.token],
    blockNumber,
  }),
]);
if (support.some((supported) => !supported)) throw new Error('Settlement token is not supported by every TEA contract');

const [tokenCodeHash, streamCodeHash, escrowCodeHash, dateUnlockCodeHash] =
  await Promise.all([
    codeHash(env.token, 'Settlement token'),
    codeHash(env.stream, 'TeaStream'),
    codeHash(env.escrow, 'TeaClaimEscrow'),
    codeHash(env.dateUnlock, 'TeaDateUnlock'),
  ]);

console.log(
  JSON.stringify(
    {
      chainId,
      blockNumber: blockNumber.toString(),
      token: {
        address: env.token,
        name,
        symbol,
        decimals,
        runtimeCodeHash: tokenCodeHash,
      },
      teaStream: {
        address: env.stream,
        token: env.token,
        runtimeCodeHash: streamCodeHash,
      },
      teaClaimEscrow: {
        address: env.escrow,
        token: env.token,
        runtimeCodeHash: escrowCodeHash,
      },
      teaDateUnlock: {
        address: env.dateUnlock,
        token: env.token,
        runtimeCodeHash: dateUnlockCodeHash,
      },
    },
    null,
    2,
  ),
);
