import { createPublicClient, erc20Abi, http, isAddress, keccak256 } from 'viem';

const { RPC_URL, CHAIN_ID, SETTLEMENT_TOKEN, SETTLEMENT_TOKEN_DECIMALS } = process.env;
const expectedChainId = Number(CHAIN_ID);
const expectedDecimals = Number(SETTLEMENT_TOKEN_DECIMALS);

if (
  !RPC_URL ||
  !isAddress(SETTLEMENT_TOKEN ?? '') ||
  !Number.isSafeInteger(expectedChainId) ||
  expectedChainId <= 0 ||
  !Number.isInteger(expectedDecimals) ||
  expectedDecimals < 0 ||
  expectedDecimals > 255
) {
  throw new Error('Set RPC_URL, CHAIN_ID, SETTLEMENT_TOKEN and SETTLEMENT_TOKEN_DECIMALS');
}

const client = createPublicClient({ transport: http(RPC_URL, { timeout: 5000 }) });
const chainId = await client.getChainId();
if (chainId !== expectedChainId) {
  throw new Error(`Wrong chain: expected ${expectedChainId}, received ${chainId}`);
}
const blockNumber = await client.getBlockNumber();
const code = await client.getBytecode({ address: SETTLEMENT_TOKEN, blockNumber });
if (!code || code === '0x') throw new Error('Settlement token has no bytecode');
const [name, symbol, decimals] = await Promise.all(
  ['name', 'symbol', 'decimals'].map((functionName) =>
    client.readContract({
      address: SETTLEMENT_TOKEN,
      abi: erc20Abi,
      functionName,
      blockNumber,
    }),
  ),
);
if (decimals !== expectedDecimals) {
  throw new Error(`Wrong decimals: expected ${expectedDecimals}, received ${decimals}`);
}

console.log(JSON.stringify({
  chainId,
  blockNumber: blockNumber.toString(),
  token: SETTLEMENT_TOKEN,
  name,
  symbol,
  decimals,
  runtimeCodeHash: keccak256(code),
}, null, 2));
