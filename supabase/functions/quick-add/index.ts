// Siri Shortcut endpoint: POST {text, kind: "home"|"work"|"event"} → creates an item, returns a sentence for Siri to speak.
import * as chrono from "npm:chrono-node@2";
import { createClient } from "npm:@supabase/supabase-js@2";
import { findSlot, parseItem, pushForward } from "./parse.js";

const OWNER_ID = "3d9a079e-d2d8-4ab7-8e40-59ff789bff67"; // patricio.mcon@gmail.com
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const fmtTime = (t: string) => {
  let [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")}${ap}` : `${h}${ap}`;
};
const say = (message: string, status = 200) => Response.json({ message }, { status });

Deno.serve(async (req) => {
  const token = Deno.env.get("QUICKADD_TOKEN");
  if (!token || req.headers.get("x-quickadd-token") !== token) return say("Not authorized.", 403);

  let body: { text?: string; kind?: string };
  try { body = await req.json(); } catch { return say("I didn't get that.", 400); }
  const text = (body.text ?? "").trim();
  const kind = ["home", "work", "event"].includes(body.kind ?? "") ? body.kind! : "home";
  if (!text) return say("I didn't hear a to-do.", 400);
  console.log("quick-add", JSON.stringify({ text, kind })); // raw dictation, for debugging misparses

  // Same time zone the phone last reported for reminders.
  const { data: sub } = await sb.from("push_subscriptions").select("tz").eq("user_id", OWNER_ID)
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  const tz = sub?.tz || "America/Toronto";

  const { dateGiven, ...item } = parseItem(chrono, text, kind, tz);
  const timeGiven = !!item.start_time;
  const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const now = { date: nowLocal.toLocaleDateString("en-CA"), min: nowLocal.getHours() * 60 + nowLocal.getMinutes() };
  const busyFrom = async (date: string) => {
    const { data } = await sb.from("items").select("date, start_time, duration")
      .eq("user_id", OWNER_ID).gte("date", date).not("start_time", "is", null);
    return (data ?? []).map((b) => ({ date: b.date, start: b.start_time.slice(0, 5), duration: b.duration }));
  };

  // No time said: tasks go in the first free gap (today until 9pm, else from 9am next day).
  // Events without a time stay all-day (birthdays etc.).
  if (!timeGiven && item.type === "task") {
    const slot = findSlot(await busyFrom(item.date), dateGiven ? item.date : now.date, now, item.duration);
    if (slot) { item.date = slot.date; item.start_time = slot.start; }
  }
  if (!item.start_time) { item.duration = null; item.remind = 0; }

  // Time said: open to-dos in the way slide later; past 9pm they go to the next free gap from 9am.
  const moved: string[] = [];
  if (timeGiven) {
    const { data: day } = await sb.from("items").select("id, title, type, done, start_time, duration")
      .eq("user_id", OWNER_ID).eq("date", item.date).not("start_time", "is", null);
    const rows = day ?? [];
    const { moves, overflow } = pushForward(
      rows.map((r) => ({ id: r.id, type: r.type, done: r.done, start: r.start_time.slice(0, 5), duration: r.duration })),
      item.start_time!, item.duration!);
    const title = (id: string) => rows.find((r) => r.id === id)!.title;
    for (const m of moves) {
      await sb.from("items").update({ start_time: m.start }).eq("id", m.id);
      moved.push(`${title(m.id)} to ${fmtTime(m.start)}`);
    }
    if (overflow.length) {
      const next = new Date(item.date + "T12:00:00Z"); next.setUTCDate(next.getUTCDate() + 1);
      const busy = await busyFrom(next.toISOString().slice(0, 10));
      for (const id of overflow) {
        const r = rows.find((x) => x.id === id)!;
        const slot = findSlot(busy, next.toISOString().slice(0, 10), now, r.duration || 30);
        if (!slot) continue;
        await sb.from("items").update({ date: slot.date, start_time: slot.start }).eq("id", id);
        busy.push({ date: slot.date, start: slot.start, duration: r.duration });
        moved.push(`${r.title} to ${dayLabel(slot.date)} at ${fmtTime(slot.start)}`);
      }
    }
  }

  const { error } = await sb.from("items").insert({ ...item, user_id: OWNER_ID });
  if (error) return say("Sorry, I couldn't save it.", 500);

  return say(`Added ${item.title}, ${dayLabel(item.date)}${item.start_time ? " at " + fmtTime(item.start_time) : ""}.`
    + (moved.length ? ` Moved ${moved.join(", and ")}.` : ""));

  function dayLabel(date: string) {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
    const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString("en-CA", { timeZone: tz });
    return date === today ? "today" : date === tomorrow ? "tomorrow"
      : new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  }
});
