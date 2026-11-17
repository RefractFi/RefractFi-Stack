// Vercel Routing Middleware: the app (dashboard) and the agent API are not offered in the US, UK or Canada
// (Terms §eligibility). Country comes from Vercel's edge (`x-vercel-ip-country`, set from the client IP).
// Marketing, docs and legal pages stay readable everywhere. The contracts themselves are permissionless.
// ponytail: IP geo only (VPNs pass); add wallet screening / attestation before mainnet if counsel requires it.
// US (+ territories), UK, Canada; plus comprehensively sanctioned countries and regions (Cuba, Iran, North Korea,
// Syria; Crimea, Sevastopol, Donetsk, Luhansk by ISO 3166-2 subdivision).
export const BLOCKED = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'GB', 'CA', 'CU', 'IR', 'KP', 'SY']);
// Some geo databases report Crimea/Sevastopol under RU (non-ISO "CR"/"SEV"); DPR/LPR have no RU code to match.
export const BLOCKED_REGIONS = new Set(['UA-43', 'UA-40', 'UA-14', 'UA-09', 'RU-CR', 'RU-SEV']);
const REGIONAL = new Set([...BLOCKED_REGIONS].map((r) => r.split('-')[0]));

export const config = { matcher: ['/dashboard', '/dashboard/:path*', '/api/mcp', '/api/telegram-link'] };

const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not available in your region · RefractFi</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07080a;color:#e8eaed;font:16px/1.6 Inter,system-ui,sans-serif;padding:24px}main{max-width:480px}h1{font-size:22px;margin:0 0 8px}a{color:#9ab4ff}</style>
<main><h1>RefractFi isn't available in your region</h1>
<p>The RefractFi app is not offered to persons in the United States, the United Kingdom, Canada, or sanctioned countries and regions. See the <a href="/legal/terms">Terms</a>.</p>
<p><a href="/">Back to refractfi.org</a></p></main>`;

export default function middleware(request) {
  const country = (request.headers.get('x-vercel-ip-country') || '').toUpperCase();
  // Vercel sends the subdivision part only ("43"); accept a "UA-43" form too.
  const raw = (request.headers.get('x-vercel-ip-country-region') || '').toUpperCase().trim();
  let sub = raw.startsWith(country + '-') ? raw.slice(country.length + 1) : raw;
  if (/^\d$/.test(sub)) sub = '0' + sub; // "9" -> "09"
  const regionUnknown = REGIONAL.has(country) && !/^[A-Z0-9]{2,3}$/.test(sub); // fail closed where the block is regional
  if (country && !BLOCKED.has(country) && !BLOCKED_REGIONS.has(`${country}-${sub}`) && !regionUnknown) return; // continue; unknown country fails closed
  const api = new URL(request.url).pathname.startsWith('/api/');
  return api
    ? Response.json({ error: 'RefractFi is not available in your region (US, UK, Canada, sanctioned countries and regions).' }, { status: 451 })
    : new Response(page, { status: 451, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
