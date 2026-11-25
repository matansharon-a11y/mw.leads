import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

export function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

// the signed-in team member behind this request, or null
export async function teamMember(req: Request, db: SupabaseClient): Promise<{ email: string; name: string; can_delete?: boolean } | null> {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await db.auth.getUser(jwt);
  const email = data?.user?.email?.toLowerCase();
  if (error || !email || !data.user.email_confirmed_at) return null;
  const { data: t } = await db.from("team").select("email,name,can_delete").eq("email", email).maybeSingle();
  return t || null;
}

export class MondayError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

// monday credits every change to the owner of the token that made it. So a change a person makes is always made
// with that person's own monday token (secret MONDAY_TOKENS, one per line: email,token), and monday's activity log
// shows who really did it. There is no fallback (Jeinna, 25 Nov 2026): without their own token the change isn't made
// and the person is told to set it up. The shared MONDAY_API_TOKEN is only for the background sync (reading monday).
export function ownToken(email: string) {
  for (const line of (Deno.env.get("MONDAY_TOKENS") || "").split(/\r?\n/)) {
    const i = line.indexOf(",");
    if (i > 0 && line.slice(0, i).trim().toLowerCase() === email.toLowerCase() && line.slice(i + 1).trim()) return line.slice(i + 1).trim();
  }
  return "";
}

// one call to monday's API: as the person (their own token, required) or, with no person, the shared sync token
export async function monday(query: string, variables: Record<string, unknown> = {}, as?: string): Promise<any> {
  if (as) {
    const own = ownToken(as);
    if (!own) throw new MondayError("no_own_token", "This person's own monday token isn't set up yet");
    try { return await callMonday(own, query, variables); }
    catch (e) { if (e instanceof MondayError && e.code === "needs_reauth") throw new MondayError("own_token_refused", "monday refused this person's own token"); throw e; }
  }
  return callMonday(Deno.env.get("MONDAY_API_TOKEN"), query, variables);
}
async function callMonday(token: string | undefined, query: string, variables: Record<string, unknown>) {
  if (!token) throw new MondayError("no_token", "The monday API token isn't set yet");
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2025-04" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) throw new MondayError("needs_reauth", "monday refused the token");
  if (!r.ok || body.errors || body.error_message) {
    const msg = body.errors?.[0]?.message || body.error_message || ("HTTP " + r.status);
    throw new MondayError("tool_error", String(msg));
  }
  return body.data;
}
