import { renderTeaEmail } from './tea-email';

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
