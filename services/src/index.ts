// One worker process for all keepers. Each starts only if its key is configured.
import { startPusher, status as pusher } from "./pusher";
import { startSettler, status as settler } from "./settler";
import { startGuard, status as guard } from "./guard";
import { startIndexer, status as indexer } from "./indexer";
import { startTracePoster, status as traces } from "./tracePoster";
import { startAlerts, status as alerts } from "./alerts";
import { startGym, status as gym } from "./gym";

const STALE_MS = 60_000;
const running: Record<string, { fresh: () => boolean; report: () => object }> = {};

function run(name: string, keyEnv: string, start: () => Promise<void>, fresh: () => boolean, report: () => object) {
  if (!process.env[keyEnv]) return console.log(`[worker] ${name} off (${keyEnv} not set)`);
  running[name] = { fresh, report };
  start().catch((e) => {
    console.error(`[${name}] fatal`, e);
    process.exit(1); // Railway restarts the worker
  });
}

const age = (t: number) => Date.now() - t < STALE_MS;
// Public endpoint: counters only. Error text stays in server logs (it can contain RPC URLs with API keys).
run("pusher", "PUSHER_PK", startPusher, () => age(pusher.lastOk), () => {
  const { lastOk, lastBoundary, pushed, skipped, missed } = pusher;
  return { lastOk, lastBoundary, pushed, skipped, missed };
});
run("settler", "SETTLER_PK", startSettler, () => age(settler.lastPoll), () => {
  const { lastPoll, settled, voided, pending } = settler;
  return { lastPoll, settled, voided, pending };
});
run("guard", "KEEPER_PK", startGuard, () => age(guard.lastPoll), () => {
  // warnings (index mismatch, capped work set, chain-scan fallback) are visible here without being fatal
  const { lastPoll, enforced, liquidated, crystals, beams, source, warnings } = guard;
  return { lastPoll, enforced, liquidated, crystals, beams, source, warnings };
});
run("indexer", "SUPABASE_SECRET_KEY", startIndexer, () => age(indexer.lastPoll), () => {
  const { lastPoll, lastBlock, events, snapshots } = indexer;
  return { lastPoll, lastBlock, events, snapshots };
});
run("alerts", "SUPABASE_SECRET_KEY", startAlerts, () => age(alerts.lastPoll), () => {
  const { lastPoll, alerts: n, sent, low, priceAge } = alerts;
  return { lastPoll, alerts: n, sent, lowBalance: low, priceAge }; // keeper wallets below their gas floor; BTC/USD age (s)
});
run("gym", "SUPABASE_SECRET_KEY", startGym, () => age(gym.lastPoll), () => {
  const { lastPoll, seasons, promoted, ranked } = gym;
  return { lastPoll, seasons, promoted, ranked };
});
// The poster sleeps an hour between epochs, so "fresh" allows one epoch plus slack.
run("traces", "POSTER_PK", startTracePoster, () => Date.now() - traces.lastPoll < 2 * 3600_000 + 60_000, () => {
  const { lastPoll, epochs, leaves } = traces;
  return { lastPoll, epochs, leaves };
});

Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  fetch(req) {
    if (new URL(req.url).pathname !== "/health") return new Response("not found", { status: 404 });
    const ok = Object.values(running).every((k) => k.fresh());
    const body = Object.fromEntries(Object.entries(running).map(([n, k]) => [n, k.report()]));
    return Response.json({ ok, ...body }, { status: ok ? 200 : 503 });
  },
});
