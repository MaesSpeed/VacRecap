import { createClient } from "./vendor/supabase-js-2.49.4.mjs";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";

let client = null;

export function getSupabase() {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: window.localStorage,
      },
    });
  }
  return client;
}
