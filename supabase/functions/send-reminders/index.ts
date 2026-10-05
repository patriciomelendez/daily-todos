// Called every minute by pg_cron. Sends a web push for each reminder that just came due.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT")!,
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const fmtTime = (t: string) => {
  let [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")}${ap}` : `${h}${ap}`;
};
const fmtLead = (min: number) =>
  min >= 1440 ? "Tomorrow" : min >= 60 ? `In ${+(min / 60).toFixed(1)} h` : `In ${min} min`;

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  const { data: due, error } = await sb.rpc("due_reminders");
  if (error) return new Response(error.message, { status: 500 });

  let sent = 0;
  for (const r of due ?? []) {
    // Claim first so an overlapping run can't double-send.
    const { error: claimErr } = await sb.from("sent_reminders").insert({ item_id: r.item_id, remind_at: r.remind_at });
    if (claimErr) continue;

    const { data: subs } = await sb.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", r.user_id);
    const payload = JSON.stringify({
      title: r.title,
      body: `${fmtLead(r.remind)} at ${fmtTime(r.start_time)}${r.location ? " · " + r.location : ""}`,
      tag: r.item_id,
    });
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("id", s.id);
        else console.error("push failed", code, (e as Error).message);
      }
    }
  }
  return Response.json({ due: due?.length ?? 0, sent });
});
