import { claimIdentityCommitment, newClaimBinding } from './claim.crypto';

describe('private claim binding', () => {
  it('uses a unique secret and preserves the verified email normalization rule', () => {
    const first = newClaimBinding();
    const second = newClaimBinding();
    expect(first.claimId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.secret).toMatch(/^0x[0-9a-f]{64}$/);
    expect(second.claimId).not.toBe(first.claimId);
    expect(second.secret).not.toBe(first.secret);

    const commitment = claimIdentityCommitment(
      first.claimId,
      'Name+tag@EXAMPLE.COM',
      first.secret,
    );
    expect(commitment).toBe(
      claimIdentityCommitment(
        first.claimId,
        'Name+tag@example.com',
        first.secret,
      ),
    );
    expect(commitment).not.toBe(
      claimIdentityCommitment(
        first.claimId,
        'name+tag@example.com',
        first.secret,
      ),
    );
    expect(commitment).not.toBe(
      claimIdentityCommitment(
        first.claimId,
        'Name+tag@example.com',
        second.secret,
      ),
    );
    expect(commitment).not.toBe(
      claimIdentityCommitment(
        second.claimId,
        'Name+tag@example.com',
        first.secret,
      ),
    );
  });
});
