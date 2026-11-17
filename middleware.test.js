// bun test middleware.test.js
import { expect, test } from 'bun:test';
import middleware from './middleware.js';

const req = (path, country) =>
  new Request('https://refractfi.org' + path, { headers: country ? { 'x-vercel-ip-country': country } : {} });

test('blocks US/UK/Canada (incl. US territories) on the app and API', async () => {
  for (const c of ['US', 'GB', 'CA', 'PR']) expect(middleware(req('/dashboard', c)).status).toBe(451);
  const api = middleware(req('/api/mcp', 'US'));
  expect(api.status).toBe(451);
  expect((await api.json()).error).toContain('not available');
});

test('lets everyone else through', () => {
  for (const c of ['FR', 'DE', 'AE', 'SG', 'fr']) expect(middleware(req('/dashboard', c))).toBeUndefined();
});

test('fails closed when the country is unknown', () => {
  expect(middleware(req('/dashboard')).status).toBe(451);
  expect(middleware(req('/dashboard', 'us')).status).toBe(451);
});

test('blocks sanctioned countries and occupied regions, not the rest of Ukraine', () => {
  for (const c of ['CU', 'IR', 'KP', 'SY']) expect(middleware(req('/dashboard', c)).status).toBe(451);
  const ua = (region) => new Request('https://refractfi.org/dashboard', { headers: { 'x-vercel-ip-country': 'UA', 'x-vercel-ip-country-region': region } });
  for (const r of ['43', '40', '14', '09']) expect(middleware(ua(r)).status).toBe(451);
  expect(middleware(ua('30'))).toBeUndefined(); // Kyiv
  expect(middleware(ua('UA-43')).status).toBe(451); // prefixed form
  expect(middleware(ua('')).status).toBe(451); // Ukraine, region unknown: fail closed
  expect(middleware(ua('9')).status).toBe(451); // unpadded Luhansk
  expect(middleware(ua(' 43 ')).status).toBe(451);
  expect(middleware(ua('UA-UA-43')).status).toBe(451); // malformed: fail closed
  const ru = (region) => new Request('https://refractfi.org/dashboard', { headers: { 'x-vercel-ip-country': 'RU', 'x-vercel-ip-country-region': region } });
  for (const r of ['CR', 'SEV', '']) expect(middleware(ru(r)).status).toBe(451); // Crimea reported under RU; unknown region
  expect(middleware(ru('MOW'))).toBeUndefined(); // Moscow
});
