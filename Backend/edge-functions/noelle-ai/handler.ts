import { MODEL, MAX_OUTPUT_TOKENS, INSTRUCTIONS, REPLY_FORMAT, buildInput, extractReply, gifUrl, usageMicros } from "./persona.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors,
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
const errors: Record<string, [number, string]> = {
  owner_required: [403, "Noelle AI is available to owners only."],
  noelle_disabled: [503, "Noelle AI is turned off."],
  consent_unavailable: [503, "Noelle AI is unavailable."],
  invalid_source: [400, "Mention @NoelleAI in a new channel message."],
  noelle_not_invoked: [400, "Mention @NoelleAI in your message."],
  channel_unavailable: [403, "Noelle AI cannot reply in this channel."],
  account_unavailable: [403, "An active account is required."],
  rate_minute: [429, "Wait a minute before mentioning Noelle AI again."],
  rate_day: [429, "You have reached your daily Noelle AI limit."],
  budget_day: [429, "Noelle AI has reached its daily spending limit."],
  busy: [429, "Noelle AI is busy. Try again shortly."],
  corpus_unavailable: [503, "Noelle AI's message examples are unavailable."],
  openai_not_configured: [503, "Noelle AI's API key is not configured."],
};

export function createHandler(deps: { env: (name: string) => string | undefined; createClient: any; fetch: typeof fetch }) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const authorization = req.headers.get("authorization") || "";
    const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    if (!token) return json({ error: "Signed-in session required" }, 401);
    if (Number(req.headers.get("content-length") || 0) > 4096) return json({ error: "Request is too large" }, 413);
    let body: any;
    try {
      const raw = await req.text();
      if (new TextEncoder().encode(raw).length > 4096) return json({ error: "Request is too large" }, 413);
      body = JSON.parse(raw);
    } catch { return json({ error: "A JSON request body is required" }, 400); }
    if (body?.action !== "reply" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body?.source_message_id || "")) {
      return json({ error: "Invalid Noelle AI request" }, 400);
    }
    const key = (modern: string, legacy: string) => {
      try { const value = JSON.parse(deps.env(modern) || "{}").default; if (value) return value; } catch { /* legacy */ }
      return deps.env(legacy) || "";
    };
    const url = deps.env("SUPABASE_URL"), publicKey = key("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY"),
      serverKey = key("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !publicKey || !serverKey) return json({ error: "Server configuration is incomplete" }, 503);
    const options = { auth: { persistSession: false, autoRefreshToken: false } };
    const admin = deps.createClient(url, serverKey, options);
    const actorClient = deps.createClient(url, publicKey, { ...options, global: { headers: { Authorization: authorization } } });
    let claimed = false, providerStarted = false, cost = 0;
    const sourceId = body.source_message_id;
    try {
      const auth = await admin.auth.getUser(token);
      if (auth.error || !auth.data?.user) return json({ error: "Signed-in session required" }, 401);
      const actorId = auth.data.user.id;
      // Enforce the caller's RLS visibility before entering service-only RPCs.
      const visible = await actorClient.from("messages").select("id").eq("id", sourceId).maybeSingle();
      if (visible.error || !visible.data) return json({ error: errors.invalid_source[1] }, 400);
      const apiKey = deps.env("OPEN_AI")?.trim() || deps.env("OPENAI_API_KEY")?.trim();
      if (!apiKey) throw new Error("openai_not_configured");
      const claim = await admin.rpc("chat_noelle_claim", { p_source_message_id: sourceId, p_actor_user_id: actorId });
      if (claim.error) throw new Error(claim.error.message);
      if (claim.data?.duplicate) return json({ ok: true, duplicate: true, status: claim.data.status,
        response_message_id: claim.data.response_message_id || null });
      claimed = true;
      const input = buildInput(claim.data);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(actorId));
      const safetyId = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
      providerStarted = true;
      const response = await deps.fetch("https://api.openai.com/v1/responses", {
        method: "POST", signal: AbortSignal.timeout(45_000),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, instructions: INSTRUCTIONS, input, reasoning: { effort: "none" },
          text: { format: REPLY_FORMAT }, max_output_tokens: MAX_OUTPUT_TOKENS, store: false, safety_identifier: safetyId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(`provider_${response.status}`);
      cost = usageMicros(payload?.usage);
      const reply = extractReply(payload);
      let mediaUrl: string | null = null;
      if (claim.data.gifs_enabled === true && reply.gif_query) {
        // Reuse the signed-in, high-content-filter GIF service. Never give
        // the model control of a URL or forward the conversation to search.
        try {
          const gifResponse = await deps.fetch(`${url}/functions/v1/klipy-gifs?q=${encodeURIComponent(reply.gif_query)}`, {
            headers: { apikey: publicKey, Authorization: authorization }, signal: AbortSignal.timeout(8000),
          });
          if (gifResponse.ok) {
            const gifs = await gifResponse.json();
            mediaUrl = (Array.isArray(gifs.items) ? gifs.items : []).map((item: any) => gifUrl(item?.url)).find(Boolean) || null;
          }
        } catch { /* A GIF outage must not lose the generated text reply. */ }
      }
      const finish = await admin.rpc("chat_noelle_finish", { p_source_message_id: sourceId, p_actor_user_id: actorId,
        p_content: reply.text, p_cost_micros: cost, p_gif_url: mediaUrl });
      if (finish.error) throw new Error("reply_save_failed");
      return json({ ok: true, model: MODEL, ...finish.data });
    } catch (error) {
      const code = error instanceof Error ? error.message : "unknown_error";
      if (claimed) {
        // Timeouts/uncertain provider failures keep the reservation: retrying
        // cannot quietly spend beyond the daily cap or post a second reply.
        try { await admin.rpc("chat_noelle_fail", { p_source_message_id: sourceId,
          p_cost_micros: cost || (providerStarted ? 5000 : 0), p_code: code.slice(0, 60) }); } catch { /* reservation remains */ }
      }
      const [status, message] = errors[code] || [502, "Noelle AI couldn't reply. Mention it again to try again."];
      console.warn("[noelle-ai] request failed", { code: errors[code] ? code : "generation_failed" });
      return json({ error: message }, status);
    }
  };
}
