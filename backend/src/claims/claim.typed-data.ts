import { hashTypedData, type Address, type Hex } from 'viem';

export type ClaimAuthorizationMessage = {
  claimId: Hex;
  identityCommitment: Hex;
  token: Address;
  amount: bigint;
  recipient: Address;
  nonce: bigint;
  deadline: bigint;
  signerEpoch: bigint;
};

const authorizationTypes = {
  ClaimAuthorization: [
    { name: 'claimId', type: 'bytes32' },
    { name: 'identityCommitment', type: 'bytes32' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'signerEpoch', type: 'uint64' },
  ],
} as const;

const acceptanceTypes = {
  ClaimAcceptance: [{ name: 'authorizationDigest', type: 'bytes32' }],
} as const;

export function claimAuthorizationTypedData(
  chainId: number,
  escrow: Address,
  message: ClaimAuthorizationMessage,
) {
  return {
    domain: {
      name: 'TeaClaimEscrow',
      version: '1',
      chainId,
      verifyingContract: escrow,
    },
    types: authorizationTypes,
    primaryType: 'ClaimAuthorization' as const,
    message,
  };
}

export function claimAcceptanceTypedData(
  chainId: number,
  escrow: Address,
  authorizationDigest: Hex,
) {
  return {
    domain: {
      name: 'TeaClaimEscrow',
      version: '1',
      chainId,
      verifyingContract: escrow,
    },
    types: acceptanceTypes,
    primaryType: 'ClaimAcceptance' as const,
    message: { authorizationDigest },
  };
}

export function claimAuthorizationDigest(
  chainId: number,
  escrow: Address,
  message: ClaimAuthorizationMessage,
): Hex {
  return hashTypedData(claimAuthorizationTypedData(chainId, escrow, message));
}

export function claimAcceptanceDigest(
  chainId: number,
  escrow: Address,
  authorizationDigest: Hex,
): Hex {
  return hashTypedData(
    claimAcceptanceTypedData(chainId, escrow, authorizationDigest),
  );
}
