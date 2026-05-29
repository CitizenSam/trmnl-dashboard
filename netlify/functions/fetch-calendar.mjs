import { google } from "googleapis";

// Set in Netlify environment variables:
// GOOGLE_SERVICE_ACCOUNT_JSON  — the full contents of your service account key JSON
// TRMNL_WEBHOOK_URL            — your plugin's webhook URL from the TRMNL dashboard
// CALENDAR_IDS                 — comma-separated list of calendar IDs to merge
// METLINK_API_KEY              — your Metlink API key

export const config = {
  schedule: "*/15 * * * *", // every 5 minutes
};

const STOP_ID = "7124";

// ── Weather code to text description ────────────────────────────────────────
function weatherDescription(code) {
  if (code === 0)  return "Clear sky";
  if (code === 1)  return "Mainly clear";
  if (code === 2)  return "Partly cloudy";
  if (code === 3)  return "Overcast";
  if (code <= 49)  return "Foggy";
  if (code <= 55)  return "Drizzle";
  if (code <= 67)  return "Rain";
  if (code <= 77)  return "Snow";
  if (code <= 82)  return "Rain showers";
  if (code <= 86)  return "Snow showers";
  if (code <= 99)  return "Thunderstorm";
  return "Unknown";
}

function weatherIcon(code) {
  if (code === 0)  return "CLEAR";
  if (code <= 2)   return "CLEAR";
  if (code === 3)  return "CLOUD";
  if (code <= 49)  return "FOG";
  if (code <= 67)  return "RAIN";
  if (code <= 77)  return "SNOW";
  if (code <= 82)  return "RAIN";
  if (code <= 86)  return "SNOW";
  if (code <= 99)  return "STORM";
  return "?";
}

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

  const nzDateStr = nowUTC.toLocaleDateString("en-NZ", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [day, month, year] = nzDateStr.split("/");
  const startOfDay = new Date(`${year}-${month}-${day}T00:00:00+12:00`);
  const endOfDay   = new Date(`${year}-${month}-${day}T23:59:59+12:00`);

  const todayLabel = startOfDay.toLocaleDateString("en-NZ", {
    timeZone: "Pacific/Auckland",
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  // ── Fetch weather from Open-Meteo (Wellington) ────────────────────────────
  let weatherTemp = "", weatherHigh = "", weatherLow = "";
  let weatherDesc = "", weatherIconText = "";

  try {
    const weatherRes = await fetch(
      "https://api.open-meteo.com/v1/forecast?latitude=-41.2865&longitude=174.7762&current=temperature_2m,weathercode&daily=temperature_2m_max,temperature_2m_min&timezone=Pacific%2FAuckland&forecast_days=1"
    );
    const weatherData = await weatherRes.json();
    const code = weatherData.current.weathercode;
    weatherTemp     = Math.round(weatherData.current.temperature_2m).toString();
    weatherHigh     = Math.round(weatherData.daily.temperature_2m_max[0]).toString();
    weatherLow      = Math.round(weatherData.daily.temperature_2m_min[0]).toString();
    weatherDesc     = weatherDescription(code);
    weatherIconText = weatherIcon(code);
    console.log(`Weather: ${weatherTemp}°C, ${weatherDesc}`);
  } catch (err) {
    console.error("Failed to fetch weather:", err.message);
  }

  // ── Fetch bus departures from Metlink ─────────────────────────────────────
  const buses = [
    { route: "", time: "" },
    { route: "", time: "" },
    { route: "", time: "" },
    { route: "", time: "" },
  ];

  try {
    const metlinkRes = await fetch(
      `https://api.opendata.metlink.org.nz/v1/stop-predictions?stop_id=${STOP_ID}`,
      {
        headers: {
          "x-api-key": process.env.METLINK_API_KEY,
          "Accept": "application/json",
        },
      }
    );

    if (!metlinkRes.ok) {
      throw new Error(`Metlink API error: ${metlinkRes.status}`);
    }

    const metlinkData = await metlinkRes.json();
    const departures = metlinkData.departures ?? [];

    // Filter to only routes 1 and 32X, take next 4
    const filtered = departures
      .filter((d) => {
        const route = (d.service_id ?? "").toString().toUpperCase();
        return route === "1" || route === "32X";
      })
      .slice(0, 4);

      filtered.forEach((d, i) => {
      // Use aimed departure time, fall back to expected
      const timeRaw = d.departure?.aimed ?? d.departure?.expected;
      const timeLabel = timeRaw
        ? new Date(timeRaw).toLocaleTimeString("en-NZ", {
            timeZone: "Pacific/Auckland",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          }).replace("am", "AM").replace("pm", "PM")
        : "";

      buses[i] = {
        route: (d.service_id ?? "").toString().toUpperCase(),
        time: timeLabel,
      };
    });

    console.log(`Got ${filtered.length} bus departures`);
console.log("Sample departure:", JSON.stringify(departures[0] ?? {}));
  } catch (err) {
    console.error("Failed to fetch bus departures:", err.message);
  }

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
      const sortTime = isAllDay
        ? new Date(`${event.start.date}T00:00:00`)
        : new Date(startRaw);
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
        time: timeLabel,
        all_day: isAllDay,
        sort_time: sortTime,
      };
    })
    .filter((event, index, arr) =>
      arr.findIndex(
        (e) => e.title === event.title && e.time === event.time
      ) === index
    )
    .sort((a, b) => a.sort_time - b.sort_time)
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
      weather_temp:    weatherTemp,
      weather_high:    weatherHigh,
      weather_low:     weatherLow,
      weather_desc:    weatherDesc,
      weather_icon:    weatherIconText,
      bus_1_route:     buses[0].route,
      bus_1_time:      buses[0].time,
      bus_2_route:     buses[1].route,
      bus_2_time:      buses[1].time,
      bus_3_route:     buses[2].route,
      bus_3_time:      buses[2].time,
      bus_4_route:     buses[3].route,
      bus_4_time:      buses[3].time,
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

  console.log(`Posted ${events.length} events, weather, and ${buses.filter(b => b.route).length} buses to TRMNL`);
}
