import { google } from "googleapis";

// Set in Netlify environment variables:
// GOOGLE_SERVICE_ACCOUNT_JSON  — the full contents of your service account key JSON
// TRMNL_WEBHOOK_URL            — your plugin's webhook URL from the TRMNL dashboard
// CALENDAR_IDS                 — comma-separated list of calendar IDs to merge
//                                e.g. "me@gmail.com,abc123@group.calendar.google.com"

export const config = {
  schedule: "*/5 * * * *", // every 5 minutes
};

export default async function handler() {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });
  const calendar = google.calendar({ version: "v3", auth });

  // ── Time range: today in NZ time ──────────────────────────────────────────
  const nowUTC = new Date();

  // NZ is UTC+12 (NZST) or UTC+13 (NZDT). Using Intl to get the correct date.
  const nzDateStr = nowUTC.toLocaleDateString("en-NZ", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-NZ gives DD/MM/YYYY — parse it
  const [day, month, year] = nzDateStr.split("/");
  const startOfDay = new Date(`${year}-${month}-${day}T00:00:00+12:00`);
  const endOfDay   = new Date(`${year}-${month}-${day}T23:59:59+12:00`);

  const todayLabel = startOfDay.toLocaleDateString("en-NZ", {
    timeZone: "Pacific/Auckland",
    weekday: "long",
    day: "numeric",
    month: "long",
  }); // e.g. "Saturday 30 May"

  // ── Fetch from each calendar ──────────────────────────────────────────────
  const calendarIds = process.env.CALENDAR_IDS.split(",").map((s) => s.trim());

  const allEvents = [];

  await Promise.all(
    calendarIds.map(async (calendarId) => {
      try {
        const res = await calendar.events.list({
          calendarId,
          timeMin: startOfDay.toISOString(),
          timeMax: endOfDay.toISOString(),
          singleEvents: true,
          orderBy: "startTime",
        });
        allEvents.push(...(res.data.items ?? []));
      } catch (err) {
        console.error(`Failed to fetch calendar ${calendarId}:`, err.message);
      }
    })
  );

  // ── Normalise & sort ──────────────────────────────────────────────────────
  const events = allEvents
    .map((event) => {
      const isAllDay = Boolean(event.start?.date && !event.start?.dateTime);
      const startRaw = isAllDay ? event.start.date : event.start.dateTime;

      // Sort key: all-day events sort to top (00:00), timed events by actual time
      const sortTime = isAllDay
        ? new Date(`${event.start.date}T00:00:00`)
        : new Date(startRaw);

      // Friendly time label in NZ time
      const timeLabel = isAllDay
        ? null
        : new Date(startRaw).toLocaleTimeString("en-NZ", {
            timeZone: "Pacific/Auckland",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          }).replace("am", "AM").replace("pm", "PM");

      return {
        title: event.summary ?? "(No title)",
        time: timeLabel,       // null for all-day
        all_day: isAllDay,
        sort_time: sortTime,
      };
    })
    // Deduplicate by title + time (same event appearing in multiple calendars)
    .filter((event, index, arr) =>
      arr.findIndex(
        (e) => e.title === event.title && e.time === event.time
      ) === index
    )
    .sort((a, b) => a.sort_time - b.sort_time)
    // Strip the internal sort key before sending
    .map(({ sort_time, ...event }) => event);

  // ── Updated-at label ──────────────────────────────────────────────────────
  const updatedAt = nowUTC.toLocaleTimeString("en-NZ", {
    timeZone: "Pacific/Auckland",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).replace("am", "AM").replace("pm", "PM")
    + " · "
    + nowUTC.toLocaleDateString("en-NZ", {
        timeZone: "Pacific/Auckland",
        weekday: "short",
        day: "numeric",
        month: "short",
      });

  // ── POST to TRMNL ─────────────────────────────────────────────────────────
  const payload = {
    merge_variables: {
      today_date:      todayLabel,
      updated_at:      updatedAt,
      calendar_events: events,
    },
  };

  const response = await fetch(process.env.TRMNL_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`TRMNL webhook failed: ${response.status} ${await response.text()}`);
  }

  console.log(`Posted ${events.length} events to TRMNL`);
}
