import { formatTeaAmount, renderTeaEmail } from './tea-email';

it('renders a branded transactional email without trusting user copy', () => {
  const email = renderTeaEmail({
    to: 'friend@example.com',
    subject: 'A TEA payment',
    preheader: 'Money from a friend',
    eyebrow: 'Payment received',
    heading: 'A little something arrived.',
    body: '<script>alert(1)</script> sent you money.',
    amount: '12 TUSD',
    ctaLabel: 'Open TEA',
    ctaUrl: 'https://usetea.example/app',
    idempotencyKey: 'test',
  });
  expect(email.html).toContain('tea<span');
  expect(email.html).toContain('&lt;script&gt;');
  expect(email.html).not.toContain('<script>alert');
  expect(email.text).toContain('12 TUSD');
});

it('labels AUSD and does not mislabel future tokens as TUSD', () => {
  expect(
    formatTeaAmount(12_500_000n, '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC'),
  ).toBe('12.5 AUSD');
  expect(
    formatTeaAmount(12_500_000n, '0x0000000000000000000000000000000000000001'),
  ).toBe('12.5 tokens');
});
