// Turns "Dentist tomorrow at 3pm at King St clinic for 1 hour" into item fields.
// chrono is passed in so the same code runs in Deno (edge function) and Node (local tests).

const pad = (n) => String(n).padStart(2, "0");

const DURATION = /\b(?:for\s+)?(\d+(?:[.,]\d+)?|an?|una?|media)\s*(hours?|hrs?|h|horas?|minutes?|mins?|minutos?)\b/i;

function parseDuration(text) {
  const m = text.match(DURATION);
  if (!m) return { minutes: null, text };
  const n = /^(an?|una?)$/i.test(m[1]) ? 1 : /^media$/i.test(m[1]) ? 0.5 : parseFloat(m[1].replace(",", "."));
  const minutes = Math.round(/^h|^hr|^hora/i.test(m[2]) ? n * 60 : n);
  return { minutes, text: text.replace(m[0], " ") };
}

export function parseItem(chrono, input, kind, tz, now = new Date()) {
  let text = ` ${input.trim().replace(/\b([ap])\.\s?m\.?/gi, "$1m").replace(/[.!]+$/, "")} `
    // "3 de la tarde" → "15:00", "9 de la mañana" → "9:00" (chrono's Spanish misses these)
    .replace(/\b(\d{1,2})(?::(\d{2}))?\s+de la (tarde|noche|mañana)\b/gi, (_, h, m, p) =>
      `${/mañana/i.test(p) || +h === 12 ? +h : +h + 12}:${m || "00"}`);
  const ref = { instant: now, timezone: tz };

  // Date/time: parse as English and Spanish, keep whichever understood the longest phrase.
  const hit = [chrono.en ?? chrono, chrono.es]
    .flatMap((p) => p.parse(text, ref, { forwardDate: true }))
    .sort((a, b) => b.text.length - a.text.length)[0] ?? null;
  let date, start = null;
  if (hit) {
    const s = hit.start;
    date = `${s.get("year")}-${pad(s.get("month"))}-${pad(s.get("day"))}`;
    if (s.isCertain("hour")) start = `${pad(s.get("hour"))}:${pad(s.get("minute") ?? 0)}`;
    // Drop the date phrase plus a dangling "on"/"el"/"at" right before it.
    const before = text.slice(0, hit.index).replace(/\s(?:on|el|at|this|este|para)\s*$/i, " ");
    text = before + " " + text.slice(hit.index + hit.text.length);
  } else {
    const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    date = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
  }

  const dur = parseDuration(text);
  text = dur.text;

  // Location: whatever follows a trailing "at"/"en"/"in".
  let location = "";
  const loc = text.match(/\s(?:at|en|in|@)\s+(.+?)\s*$/i);
  if (loc && loc[1].trim().length > 1) { location = loc[1].trim(); text = text.slice(0, loc.index); }

  let title = text.replace(/\s+(?:at|on|en|el|la|a las|para)\s*$/i, "").replace(/\s+/g, " ").trim();
  title = title.charAt(0).toUpperCase() + title.slice(1);

  return {
    title: title || input.trim(),
    type: kind === "event" ? "event" : "task",
    category: kind === "event" ? "" : kind,
    date,
    start_time: start,
    duration: start ? (dur.minutes || (kind === "event" ? 60 : 30)) : null,
    location,
    remind: start ? 60 : 0,
  };
}
