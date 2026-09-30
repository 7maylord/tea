import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData, type Address, type Hex } from 'viem';
import {
  claimAcceptanceTypedData,
  claimAuthorizationDigest,
  claimAuthorizationTypedData,
} from './claim.typed-data';

const chainId = 10143;
const escrow = '0xF3DeE532B0d0d29c4E4B64b004b7f286E1Cf9814' as Address;
const otherEscrow = '0x0A695c494ecF2c18dD26FB60F95FbD7d105EfB84' as Address;
const token = '0x82cE012544F85E33930C5272bdeAE76736A8F22b' as Address;
const recipient = privateKeyToAccount(
  '0x59c6995e998f97a5a004497e5da3bbb29c0cd770b4fae3f4f0aae4318c6f7d85',
);
const attacker = privateKeyToAccount(
  '0x5de4111a56e5465d4f8e6d4d50e5ab629fcfe333a3d43f180bf6a064d80f3a23',
);
const message = {
  claimId: `0x${'12'.repeat(32)}` as Hex,
  identityCommitment: `0x${'34'.repeat(32)}` as Hex,
  token,
  amount: 5_000_000n,
  recipient: recipient.address,
  nonce: 0n,
  deadline: 1_790_359_253n,
  signerEpoch: 1n,
};

it('binds claim authorizations to the recipient and escrow domain', () => {
  const digest = claimAuthorizationDigest(chainId, escrow, message);
  expect(
    claimAuthorizationDigest(chainId, escrow, {
      ...message,
      recipient: attacker.address,
    }),
  ).not.toBe(digest);
  expect(claimAuthorizationDigest(chainId, otherEscrow, message)).not.toBe(
    digest,
  );
});

it('acceptance signatures cannot be reused by another recipient', async () => {
  const digest = claimAuthorizationDigest(chainId, escrow, message);
  const signature = await recipient.signTypedData(
    claimAcceptanceTypedData(chainId, escrow, digest),
  );

  await expect(
    verifyTypedData({
      address: recipient.address,
      ...claimAcceptanceTypedData(chainId, escrow, digest),
      signature,
    }),
  ).resolves.toBe(true);
  await expect(
    verifyTypedData({
      address: attacker.address,
      ...claimAcceptanceTypedData(chainId, escrow, digest),
      signature,
    }),
  ).resolves.toBe(false);
  await expect(
    verifyTypedData({
      address: recipient.address,
      ...claimAcceptanceTypedData(
        chainId,
        escrow,
        claimAuthorizationDigest(chainId, escrow, {
          ...message,
          recipient: attacker.address,
        }),
      ),
      signature,
    }),
  ).resolves.toBe(false);
});

it('identity signatures cannot move the payment to another recipient', async () => {
  const signer = privateKeyToAccount(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  );
  const signature = await signer.signTypedData(
    claimAuthorizationTypedData(chainId, escrow, message),
  );

  await expect(
    verifyTypedData({
      address: signer.address,
      ...claimAuthorizationTypedData(chainId, escrow, message),
      signature,
    }),
  ).resolves.toBe(true);
  await expect(
    verifyTypedData({
      address: signer.address,
      ...claimAuthorizationTypedData(chainId, escrow, {
        ...message,
        recipient: attacker.address,
      }),
      signature,
    }),
  ).resolves.toBe(false);
});
