import { parseEther } from 'viem';
import { needsGasGrant } from './faucet.service';

describe('gas allowance', () => {
  it('keeps a daily grant available while the wallet can fund another transaction', () => {
    expect(needsGasGrant(parseEther('0.019'))).toBe(true);
    expect(needsGasGrant(parseEther('0.02'))).toBe(false);
  });
});
