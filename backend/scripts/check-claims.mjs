import { createPublicClient, formatEther, http, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import escrowAbi from '../src/abi/TeaClaimEscrow.json' with { type: 'json' };
import monad from '../src/abi/monad-testnet.json' with { type: 'json' };

function privateKey(name) {
  const value = process.env[name];
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed private key`);
  }
  return value;
}

const rpcUrl = process.env.RPC_URL;
const chainId = Number(process.env.CHAIN_ID ?? monad.chainId);
const escrow = process.env.CLAIM_ESCROW_ADDRESS ?? monad.teaClaimEscrow;
const token = process.env.SETTLEMENT_TOKEN ?? monad.settlementToken;

if (!rpcUrl || !Number.isSafeInteger(chainId) || chainId <= 0 || !isAddress(escrow) || !isAddress(token)) {
  throw new Error('Set RPC_URL, CHAIN_ID, SETTLEMENT_TOKEN and CLAIM_ESCROW_ADDRESS');
}

const identityAccount = privateKeyToAccount(privateKey('CLAIM_IDENTITY_SIGNER_PRIVATE_KEY'));
const relayerAccount = privateKeyToAccount(privateKey('RELAYER_PRIVATE_KEY'));
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 5000 }) });

const liveChainId = await client.getChainId();
if (liveChainId !== chainId) throw new Error(`Wrong chain: expected ${chainId}, received ${liveChainId}`);

const blockNumber = await client.getBlockNumber();
const [tokenSupported, identitySigner, signerEpoch, owner, paused, relayerBalance] = await Promise.all([
  client.readContract({ address: escrow, abi: escrowAbi, functionName: 'supportedTokens', args: [token], blockNumber }),
  client.readContract({ address: escrow, abi: escrowAbi, functionName: 'identitySigner', blockNumber }),
  client.readContract({ address: escrow, abi: escrowAbi, functionName: 'signerEpoch', blockNumber }),
  client.readContract({ address: escrow, abi: escrowAbi, functionName: 'owner', blockNumber }),
  client.readContract({ address: escrow, abi: escrowAbi, functionName: 'paused', blockNumber }),
  client.getBalance({ address: relayerAccount.address, blockNumber }),
]);

if (!tokenSupported) throw new Error(`Claim escrow does not support ${token}`);
if (identityAccount.address.toLowerCase() !== identitySigner.toLowerCase()) {
  throw new Error(`CLAIM_IDENTITY_SIGNER_PRIVATE_KEY resolves to ${identityAccount.address}, but escrow identitySigner is ${identitySigner}`);
}
if (relayerBalance === 0n) {
  throw new Error(`RELAYER_PRIVATE_KEY resolves to ${relayerAccount.address}, but it has no native balance for relaying claims`);
}

console.log(JSON.stringify({
  chainId: liveChainId,
  blockNumber: blockNumber.toString(),
  claimEscrow: escrow,
  token,
  owner,
  paused,
  identitySigner,
  signerEpoch: signerEpoch.toString(),
  configuredIdentitySigner: identityAccount.address,
  relayer: relayerAccount.address,
  relayerNativeBalance: relayerBalance.toString(),
  relayerNativeBalanceFormatted: formatEther(relayerBalance),
}, null, 2));
