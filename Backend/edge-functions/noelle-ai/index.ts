import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.108.2";
import { createHandler } from "./handler.ts";

Deno.serve(createHandler({ env: name => Deno.env.get(name), createClient, fetch }));
