/** Listing URIs are agent-controlled and shown as links: parse them and allow only https: and ipfs:.
 *  Returns the normalized href to store/encode, or null. Used by the MCP server and the indexer (the dashboard
 *  has the same check). */
export const safeUri = (u: unknown): string | null => {
  try {
    const p = new URL(String(u));
    return ["https:", "ipfs:"].includes(p.protocol) ? p.href : null;
  } catch {
    return null;
  }
};
