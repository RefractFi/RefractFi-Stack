// Telegram linking for owner alerts. Two Vercel functions, bundled to api/telegram-link.js and api/telegram.js:
//  - linkHandler: POST {address, ts, signature}. The wallet signs a fixed message (no transaction); we check the
//    signature and a 5-minute timestamp window, then hand back a one-time t.me deep link.
//  - webhookHandler: Telegram's webhook. Only accepted with the secret token header set via setWebhook.
//    "/start <code>" links the chat to the wallet; "/stop" unlinks it.
import { createClient } from "@supabase/supabase-js";
import { keccak256, recoverMessageAddress, type Hex } from "viem";

const BOT = "Refractfi_bot";
const CODE_TTL_MS = 10 * 60_000;
const db = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
const json = (body: unknown, status = 200) => Response.json(body, { status });

/** The exact text the wallet signs. Must match src/lib/refract.js. Names the site so it can't be reused elsewhere. */
export const linkMessage = (address: string, ts: number) =>
  `refractfi.org: link Telegram alerts to ${address.toLowerCase()} (Robinhood Chain Testnet). No transaction, no cost. Time: ${ts}`;

export async function linkHandler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: { address?: string; ts?: number; signature?: Hex };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const { address, ts, signature } = body;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || !Number.isInteger(ts) || !signature) return json({ error: "address, ts and signature required" }, 400);
  const age = Date.now() / 1000 - ts!;
  if (age > 300 || age < -60) return json({ error: "signature expired, try again" }, 400);
  let signer: string;
  try { signer = await recoverMessageAddress({ message: linkMessage(address, ts!), signature }); } catch { return json({ error: "bad signature" }, 400); }
  if (signer.toLowerCase() !== address.toLowerCase()) return json({ error: "signature does not match the wallet" }, 401);
  const d = db();
  await d.from("telegram_codes").delete().lt("created_at", new Date(Date.now() - 86_400_000).toISOString()); // purge old codes
  const code = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
  // sig_hash is unique: a signature can mint exactly one code, so a captured signature can't be replayed.
  const { error } = await d.from("telegram_codes").insert({ code, owner: address.toLowerCase(), sig_hash: keccak256(signature), expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString() });
  if (error) return json({ error: error.code === "23505" ? "this signature was already used; sign again" : "could not create code" }, error.code === "23505" ? 409 : 500);
  return json({ code, url: `https://t.me/${BOT}?start=${code}` });
}

async function reply(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export async function webhookHandler(req: Request): Promise<Response> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) return json({ error: "forbidden" }, 403);
  const update = await req.json().catch(() => null);
  const msg = update?.message;
  const chatId: number | undefined = msg?.chat?.id;
  const text: string = (msg?.text ?? "").trim();
  if (!chatId) return json({ ok: true });
  if (msg.chat.type !== "private") { await reply(chatId, "RefractFi alerts can only be linked in a private chat with the bot."); return json({ ok: true }); }
  const d = db();
  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1];
    if (!code) { await reply(chatId, "Open the link from the RefractFi dashboard (Activity → Telegram alerts) to connect your wallet."); return json({ ok: true }); }
    // Atomic claim: only one update can set used_at on an unused, unexpired code.
    const { data: claimed } = await d.from("telegram_codes").update({ used_at: new Date().toISOString() })
      .eq("code", code).is("used_at", null).gt("expires_at", new Date().toISOString()).select("owner");
    const owner = claimed?.[0]?.owner as string | undefined;
    if (!owner) { await reply(chatId, "That link expired or was already used. Create a new one from the dashboard."); return json({ ok: true }); }
    const { data: prev } = await d.from("telegram_links").select("chat_id").eq("owner", owner).maybeSingle();
    await d.from("telegram_links").upsert({ owner, chat_id: chatId, linked_at: new Date().toISOString() });
    if (prev && prev.chat_id !== chatId) await reply(prev.chat_id, `RefractFi alerts for ${owner.slice(0, 6)}…${owner.slice(-4)} were moved to another Telegram chat by the wallet owner.`);
    await reply(chatId, `Linked to ${owner.slice(0, 6)}…${owner.slice(-4)}. You'll get RefractFi testnet alerts here: Beam halved or cut, margin near maintenance, liquidation, dropped crossing orders. Send /stop to unlink.`);
  } else if (text === "/chatid") {
    await reply(chatId, `Your chat ID is ${chatId}. (The operator sets it as OPERATOR_CHAT_ID to get keeper gas alarms.)`);
  } else if (text === "/stop") {
    await d.from("telegram_links").delete().eq("chat_id", chatId);
    await reply(chatId, "Unlinked. You won't get RefractFi alerts here any more.");
  }
  return json({ ok: true });
}
