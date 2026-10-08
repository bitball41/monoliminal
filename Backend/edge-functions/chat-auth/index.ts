import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.108.2";
import { canResetPassword, isOwner, usernamePattern } from "./permissions.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Account creation is otherwise unauthenticated, so keep a loose per-IP
// throttle: plenty for a household, useless for a registration script.
const SIGNUP_MAX_PER_HOUR = 10;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function validUsername(value: string) {
  return /^[A-Za-z0-9_]{3,20}$/.test(value)
    && !["claude", "system", "liminal", "admin", "luna"].includes(value.toLowerCase());
}

function accountEmail(username: string) {
  return `${username.toLowerCase()}@accounts.liminal.invalid`;
}

async function ipKey(ip: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`liminal-signup:${ip}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Fails open when the counter table is unreachable: a broken throttle must
// never block a real signup.
async function throttleSignup(admin: any, key: string) {
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const { count } = await admin
    .from("rate_events")
    .select("id", { head: true, count: "exact" })
    .eq("key", key)
    .eq("action", "signup")
    .gte("created_at", hourAgo);
  if ((count || 0) >= SIGNUP_MAX_PER_HOUR) throw new Error("rate_signup");
  await admin.from("rate_events").insert({ key, action: "signup" });
}

async function deleteChatAccount(
  admin: any,
  userId: string,
) {
  // Auth refuses to remove a user that owns Storage objects. Find and delete
  // those objects through the Storage API, then remove relational chat data
  // transactionally before deleting the Auth identity.
  const { data: ownedObjects, error: ownedObjectsError } = await admin.rpc(
    "chat_get_owned_storage_objects",
    { p_user_id: userId },
  );
  if (ownedObjectsError) throw ownedObjectsError;

  const objectsByBucket = new Map<string, string[]>();
  for (const object of ownedObjects || []) {
    const bucket = String(object.bucket_id || "");
    const name = String(object.name || "");
    if (!bucket || !name) continue;
    const names = objectsByBucket.get(bucket) || [];
    names.push(name);
    objectsByBucket.set(bucket, names);
  }
  for (const [bucket, names] of objectsByBucket) {
    // Storage removal accepts batches; keep them deliberately small.
    for (let i = 0; i < names.length; i += 100) {
      const { error } = await admin.storage.from(bucket).remove(names.slice(i, i + 100));
      if (error) throw error;
    }
  }

  const { error: cleanupError } = await admin.rpc("chat_delete_account_data", {
    p_user_id: userId,
  });
  if (cleanupError) throw cleanupError;

  const { error: authDeleteError } = await admin.auth.admin.deleteUser(userId);
  if (authDeleteError) throw authDeleteError;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const apiKey = req.headers.get("apikey")?.trim() || "";
  const publishableKeys = Object.values(
    JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}"),
  );
  if (!apiKey || !publishableKeys.includes(apiKey)) {
    return json({ error: "Invalid publishable API key" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
  const serverKey = secretKeys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serverKey) {
    return json({ error: "Server configuration is incomplete" }, 500);
  }

  const admin = createClient(supabaseUrl, serverKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "A JSON request body is required" }, 400);
  }

  const action = String(body.action || "");

  if (action === "signup") {
    const username = String(body.username || "").trim();
    const displayName = String(body.display_name || "").trim();
    const password = String(body.password || "");
    const deviceId = String(body.device_id || "").trim();

    if (!validUsername(username)) return json({ error: "Invalid or reserved username" }, 400);
    if (displayName.length < 1 || displayName.length > 40) {
      return json({ error: "Display name must be 1-40 characters" }, 400);
    }
    if (password.length < 6 || password.length > 72) {
      return json({ error: "Password must be 6-72 characters" }, 400);
    }
    if (deviceId.length < 16 || deviceId.length > 200) {
      return json({ error: "A valid device identifier is required" }, 400);
    }

    const ip = req.headers.get("cf-connecting-ip")
      || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || "unknown";
    try {
      await throttleSignup(admin, await ipKey(ip));
    } catch (error) {
      if (error instanceof Error && error.message === "rate_signup") {
        return json({ error: "Too many new accounts from this network. Try again in an hour." }, 429);
      }
      console.warn("[chat-auth] signup throttle unavailable", error);
    }

    const [{ data: registrationSetting }, { data: deviceBan }] = await Promise.all([
      admin.from("app_settings").select("value").eq("key", "registrations_enabled").maybeSingle(),
      admin.rpc("chat_check_device_ban", { p_device_id: deviceId }),
    ]);
    if (registrationSetting?.value === "false") {
      return json({ error: "New account registration is disabled" }, 403);
    }
    if (deviceBan) return json({ error: "This device is banned" }, 403);

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: accountEmail(username),
      password,
      email_confirm: true,
      user_metadata: { username },
    });
    if (createError || !created.user) {
      const duplicate = createError?.message?.toLowerCase().includes("already");
      return json({ error: duplicate ? "That username is already taken" : "Could not create account" }, duplicate ? 409 : 400);
    }

    const { data: completed, error: profileError } = await admin.rpc("chat_complete_signup", {
      p_user_id: created.user.id,
      p_username: username,
      p_display_name: displayName,
      p_is_test_account: false,
    });
    if (profileError) {
      await admin.auth.admin.deleteUser(created.user.id);
      const duplicate = profileError.code === "23505"
        || profileError.message.toLowerCase().includes("already");
      return json({ error: duplicate ? "That username is already taken" : "Could not create profile" }, duplicate ? 409 : 400);
    }
    return json({ ok: true, ...completed }, 201);
  }

  const authorization = req.headers.get("authorization") || "";
  const accessToken = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) return json({ error: "Signed-in session required" }, 401);
  const { data: authData, error: authError } = await admin.auth.getUser(accessToken);
  if (authError || !authData.user) return json({ error: "Signed-in session required" }, 401);

  const { data: actor } = await admin.from("profiles")
    .select("username,staff_role,is_banned,user_id")
    .eq("user_id", authData.user.id)
    .maybeSingle();
  if (!actor || actor.is_banned) return json({ error: "Active account required" }, 403);

  if (action === "delete_account") {
    try {
      await deleteChatAccount(admin, authData.user.id);
    } catch {
      return json({ error: "Could not delete account" }, 400);
    }
    return json({ ok: true });
  }

  if (action === "admin_reset_password") {
    const target = String(body.username || "").trim();
    const pattern = usernamePattern(target);
    if (!pattern) return json({ error: "Invalid username" }, 400);
    const password = String(body.password || "");
    if (password.length < 6 || password.length > 72) {
      return json({ error: "Password must be 6-72 characters" }, 400);
    }
    const { data: profile, error: targetError } = await admin.from("profiles")
      .select("username,user_id,staff_role,is_banned")
      .ilike("username", pattern)
      .maybeSingle();
    if (targetError) return json({ error: "Could not verify target account" }, 503);
    if (!profile?.user_id) return json({ error: "Account not found" }, 404);
    if (!canResetPassword(actor, profile)) {
      return json({ error: "You can only reset another account below your staff rank" }, 403);
    }
    // Recheck live roles immediately before the Auth admin operation and audit authorization.
    const { error: permissionError } = await admin.rpc("chat_authorize_password_reset", {
      p_actor_user_id: authData.user.id,
      p_target_user_id: profile.user_id,
    });
    if (permissionError) return json({ error: "Password reset authorization failed" }, 403);
    const { error } = await admin.auth.admin.updateUserById(profile.user_id, { password });
    if (error) return json({ error: "Could not reset password" }, 400);
    return json({ ok: true });
  }

  if (action === "create_dev") {
    if (!isOwner(actor)) return json({ error: "Owner authorization required" }, 403);
    const displayName = String(body.display_name || "Dev Tester").trim();
    const password = String(body.password || "");
    if (displayName.length < 1 || displayName.length > 40) {
      return json({ error: "Display name must be 1-40 characters" }, 400);
    }
    if (password.length < 6 || password.length > 72) {
      return json({ error: "Password must be 6-72 characters" }, 400);
    }
    const username = `_devtest_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: accountEmail(username),
      password,
      email_confirm: true,
      user_metadata: { username, test_account: true },
    });
    if (createError || !created.user) return json({ error: "Could not create test account" }, 400);
    const { data: completed, error: profileError } = await admin.rpc("chat_complete_signup", {
      p_user_id: created.user.id,
      p_username: username,
      p_display_name: displayName,
      p_is_test_account: true,
    });
    if (profileError) {
      await admin.auth.admin.deleteUser(created.user.id);
      return json({ error: "Could not create test profile" }, 400);
    }
    return json({ ok: true, ...completed });
  }

  if (action === "delete_dev") {
    if (!isOwner(actor)) return json({ error: "Owner authorization required" }, 403);
    const target = String(body.username || "").trim();
    const pattern = usernamePattern(target);
    if (!pattern) return json({ error: "Invalid username" }, 400);
    const { data: profile } = await admin.from("profiles")
      .select("user_id,is_test_account")
      .ilike("username", pattern)
      .maybeSingle();
    if (!profile?.is_test_account || !profile.user_id) {
      return json({ error: "Test account not found" }, 404);
    }
    try {
      await deleteChatAccount(admin, profile.user_id);
    } catch {
      return json({ error: "Could not delete test account" }, 400);
    }
    return json({ ok: true });
  }

  return json({ error: "Unsupported action" }, 400);
});

