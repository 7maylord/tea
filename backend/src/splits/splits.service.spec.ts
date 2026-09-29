import { splitAmount } from './splits.service';

describe('splitAmount', () => {
  it('keeps the total exact and assigns rounding remainder deterministically', () => {
    expect(splitAmount(100n, 3)).toEqual([34n, 33n, 33n]);
    expect(() => splitAmount(2n, 4)).toThrow('Invalid split');
  });
});
