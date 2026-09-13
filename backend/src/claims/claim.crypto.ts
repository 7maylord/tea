import { randomBytes } from 'node:crypto';
import { encodeAbiParameters, keccak256, toHex, type Hex } from 'viem';
import { normalizeEmail } from '../identity/identity.crypto';

export const CLAIM_IDENTITY_DOMAIN = 'tea.claim.identity.v1';

export function newClaimBinding() {
  return {
    claimId: toHex(randomBytes(32)),
    secret: toHex(randomBytes(32)),
  };
}

export function claimIdentityCommitment(
  claimId: Hex,
  email: string,
  secret: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'bytes32' },
        { type: 'string' },
        { type: 'string' },
        { type: 'bytes32' },
      ],
      [CLAIM_IDENTITY_DOMAIN, claimId, 'email', normalizeEmail(email), secret],
    ),
  );
}
