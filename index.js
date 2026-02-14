import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import Ably from "ably";
import nodemailer from "nodemailer";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 5000);
const MONGO_URI = process.env.MONGO_URI;
const ABLY_KEY = process.env.ABLY_KEY;
const DEVICE_ID = process.env.DEVICE_ID || "feeder01";
const OFFLINE_AFTER_SECONDS = Number(process.env.OFFLINE_AFTER_SECONDS || 60);

// Missed feeding settings
const MISSED_GRACE_SECONDS = Number(process.env.MISSED_GRACE_SECONDS || 120);
const MISSED_CHECK_EVERY_MS = Number(process.env.MISSED_CHECK_EVERY_MS || 15000);

const OFFLINE_CHECK_EVERY_MS = Number(process.env.OFFLINE_CHECK_EVERY_MS || 5000);

if (!MONGO_URI) throw new Error("Missing MONGO_URI in .env");
if (!ABLY_KEY) throw new Error("Missing ABLY_KEY in .env");

// ---------------- EMAIL (Nodemailer) ----------------
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "true") === "true";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

const ALERT_TO = process.env.ALERT_TO; // comma separated allowed
const ALERT_FROM = process.env.ALERT_FROM; // e.g. Fish Feeder <x@gmail.com>

let seenOnlineThisSession = false;

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_TO || !ALERT_FROM) {
  console.warn("[EMAIL] Missing SMTP env vars. Email alerts disabled.");
}

function createMailer() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_TO || !ALERT_FROM) return null;

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

const mailer = createMailer();

function fmtTime(d) {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleString();
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildEmailHtml({ title, badge, lines = [], meta = {} }) {
  const metaRows = Object.entries(meta)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      return `
        <tr>
          <td style="padding:8px 10px;color:#94a3b8;border-top:1px solid #1f2937;">${escapeHtml(
            k
          )}</td>
          <td style="padding:8px 10px;color:#e5e7eb;border-top:1px solid #1f2937;text-align:right;">${escapeHtml(
            v
          )}</td>
        </tr>
      `;
    })
    .join("");

  const lineItems = lines
    .map((t) => `<li style="margin:6px 0;color:#e5e7eb;">${escapeHtml(t)}</li>`)
    .join("");

  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#0b1220;padding:18px">
    <div style="max-width:560px;margin:0 auto;background:#121a2b;border:1px solid #1f2937;border-radius:16px;overflow:hidden">
      <div style="padding:14px 16px;background:linear-gradient(135deg,#4f8cff,#22c55e);color:#061124">
        <div style="font-size:14px;font-weight:700;letter-spacing:.2px">Fish Feeder Alert</div>
      </div>

      <div style="padding:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="font-size:18px;font-weight:800;color:#e5e7eb">${escapeHtml(title)}</div>
          <div style="font-size:12px;font-weight:800;padding:6px 10px;border-radius:999px;background:#0b1220;border:1px solid #1f2937;color:#e5e7eb">
            ${escapeHtml(badge)}
          </div>
        </div>

        <ul style="margin:12px 0 0 18px;padding:0">${lineItems}</ul>

        <div style="margin-top:14px;border:1px solid #1f2937;border-radius:12px;overflow:hidden">
          <table style="width:100%;border-collapse:collapse">
            ${metaRows}
          </table>
        </div>

        
      </div>
    </div>
  </div>
  `;
}

async function sendAlertEmail({ subject, text, html }) {
  if (!mailer) return;

  try {
    await mailer.sendMail({
      from: ALERT_FROM,
      to: ALERT_TO,
      subject,
      text,
      html,
    });
    console.log("[EMAIL] sent:", subject);
  } catch (e) {
    console.log("[EMAIL] failed:", e?.message || e);
  }
}

// ✅ real cooldown (5 minutes). Set to 0 if you want no throttle.
const emailCooldownMs = 1000;
const lastEmailSentAt = new Map();



// ---------------- Mongo ----------------
const client = new MongoClient(MONGO_URI);

function nowIso() {
  return new Date().toISOString();
}

function parseEvt(raw) {
  const s = String(raw || "").trim();
  if (!s) return { type: "unknown", raw: "" };

  if (s.startsWith("{") && s.endsWith("}")) {
    try {
      const obj = JSON.parse(s);
      return { ...obj, type: obj.type || "evt", raw: s };
    } catch {
      return { type: "evt", raw: s };
    }
  }
  return { type: s, raw: s };
}

// ✅ prevents circular BSON issues by forcing plain JSON
function safeForMongo(x) {
  if (x instanceof Date) return x;
  try {
    return JSON.parse(JSON.stringify(x));
  } catch {
    return String(x);
  }
}

// ---------------- Schedule helpers (missed feed) ----------------
function parseHHMM(token) {
  const t = String(token || "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm, str: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}` };
}

function scheduleList(csv) {
  return String(csv || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map(parseHHMM)
    .filter(Boolean)
    .sort((a, b) => (a.hh * 60 + a.mm) - (b.hh * 60 + b.mm));
}

function computeLastScheduledEpoch(now, csv) {
  const list = scheduleList(csv);
  if (list.length === 0) return null;

  const y = now.getFullYear();
  const mo = now.getMonth();
  const d = now.getDate();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  let chosen = null;
  for (const t of list) {
    const m = t.hh * 60 + t.mm;
    if (m <= nowMin) chosen = t;
  }

  if (chosen) {
    const dt = new Date(y, mo, d, chosen.hh, chosen.mm, 0, 0);
    return { epoch: dt, hhmm: chosen.str };
  }

  const last = list[list.length - 1];
  const dt = new Date(y, mo, d - 1, last.hh, last.mm, 0, 0);
  return { epoch: dt, hhmm: last.str };
}

async function run() {
  
  const db = client.db();
  const devices = db.collection("devices");
  const events = db.collection("events");

  async function sendAlertOnce(deviceId, key, payload) {

    const enabled = await isEmailEnabled(deviceId);
  if (!enabled) {
    console.log("[EMAIL] skipped (disabled by user)");
    return;
  }

  const now = Date.now();
  const last = lastEmailSentAt.get(key) || 0;
  if (now - last < emailCooldownMs) return;

  lastEmailSentAt.set(key, now);
  await sendAlertEmail(payload);
}

  await devices.createIndex({ deviceId: 1 }, { unique: true });
  await events.createIndex({ deviceId: 1, ts: -1 });

  await devices.updateOne(
    { deviceId: DEVICE_ID },
    {
      $setOnInsert: {
        deviceId: DEVICE_ID,
        online: false,
        lastSeen: null,
        lastFeed: null,
        rssi: null,
        ip: null,
        scheduleCsv: "",
        config: { idleAngle: 0, feedAngle: 150, feedMs: 500, oledOn: true, emailNotify: true },
        lastMissedAt: null,
        lastMissedKey: null,
        createdAt: nowIso(),
      },
      $set: { updatedAt: nowIso() },
    },
    { upsert: true }
  );
  async function isEmailEnabled(deviceId) {
  const doc = await devices.findOne(
    { deviceId },
    { projection: {  "config.emailNotify": 1 } }
  );

  // default ON if missing
  return doc?.config?.emailNotify !== false;
}
  const ably = new Ably.Realtime({ key: ABLY_KEY });
  const evtTopic = `${DEVICE_ID}/evt`;
  const evtCh = ably.channels.get(evtTopic);
  const cmdCh = ably.channels.get(`${DEVICE_ID}/cmd`);

  // ✅ ONE function, ONE signature
  async function pushLatestStateToDevice(deviceId) {
    const dev = await devices.findOne({ deviceId });
    if (!dev) return;

    const scheduleCsv = typeof dev.scheduleCsv === "string" ? dev.scheduleCsv : "";
    const cfg = dev.config || {};

    await cmdCh.publish("cmd", JSON.stringify({ type: "set_schedule", times: scheduleCsv }));

    await cmdCh.publish(
      "cmd",
      JSON.stringify({
        type: "set_config",
        idle_angle: cfg.idleAngle ?? 0,
        feed_angle: cfg.feedAngle ?? 150,
        feed_ms: cfg.feedMs ?? 500,
        oled: cfg.oledOn ? 1 : 0,
      })
    );

    console.log("[SYNC] pushed DB state -> device");
  }

  ably.connection.on((stateChange) => {
    console.log("[ABLY]", stateChange.current);
    if (stateChange.reason) console.log("[ABLY reason]", stateChange.reason.message);
  });

  evtCh.subscribe(async (msg) => {
    const parsed = parseEvt(msg.data);
    const deviceId = DEVICE_ID;
    const ts = new Date();

    const prev = await devices.findOne(
      { deviceId },
      { projection: { online: 1, lastSeen: 1 } }
    );
    const hadSeenBefore = !!prev?.lastSeen;

    if (parsed.type === "hb") {
      const setBase = {
        lastSeen: ts,
        updatedAt: nowIso(),
        ...(typeof parsed.rssi === "number" ? { rssi: parsed.rssi } : {}),
        ...(typeof parsed.ip === "string" && parsed.ip ? { ip: parsed.ip } : {}),
      };

      const res = await devices.updateOne(
        { deviceId, online: false },
        { $set: { ...setBase, online: true } }
      );

      if (res.modifiedCount === 1) {
        

        if (hadSeenBefore) {
          await sendAlertOnce(deviceId,`${deviceId}:back_online`, {
            subject: `✅ Device back online (${deviceId})`,
            text: `Device back online.\nDevice: ${deviceId}\nTime: ${fmtTime(ts)}`,
            html: buildEmailHtml({
              title: "Device back online",
              badge: "ONLINE",
              lines: ["Heartbeat received. Device is reachable again."],
              meta: {
                Device: deviceId,
                Time: fmtTime(ts),
                RSSI: typeof parsed.rssi === "number" ? `${parsed.rssi} dBm` : "—",
                IP: parsed.ip || "—",
              },
            }),
          });
        }
      } else {
        await devices.updateOne({ deviceId }, { $set: { ...setBase, online: true } });
      }

      seenOnlineThisSession = true;
      return;
    }

    if (parsed.type === "device_online") {
      try {
        // ✅ fixed call
        await pushLatestStateToDevice(deviceId);
      } catch (e) {
        console.log("[SYNC] failed:", e?.message || e);
      }
    }

    if (parsed.type === "feed_done") {
      await devices.updateOne(
        { deviceId },
        { $set: { lastFeed: ts, updatedAt: nowIso() } }
      );

      await sendAlertOnce(deviceId,`${deviceId}:feed_done`, {
        subject: `✅ Feeding completed (${deviceId})`,
        text: `Feeding completed successfully.\n\nDevice: ${deviceId}\nTime: ${new Date(
          ts
        ).toLocaleString()}`,
        html: buildEmailHtml({
          title: "Feeding Completed",
          badge: "SUCCESS",
          lines: ["The feeder has completed its feeding cycle."],
          meta: {
            Device: deviceId,
            Time: new Date(ts).toLocaleString(),
          },
        }),
      });

      return;
    }
  });

  // ---- Offline detector ----
  setInterval(async () => {
    const now = new Date();

    // ✅ include rssi/ip because you use them in the email
    const device = await devices.findOne(
      { deviceId: DEVICE_ID },
      { projection: { lastSeen: 1, rssi: 1, ip: 1, online: 1 } }
    );
    if (!device) return;

    const lastSeen = device.lastSeen ? new Date(device.lastSeen) : null;

    const isOffline =
      !lastSeen || (now.getTime() - lastSeen.getTime()) / 1000 > OFFLINE_AFTER_SECONDS;

    if (!isOffline) return;

    const res = await devices.updateOne(
      { deviceId: DEVICE_ID, online: true },
      { $set: { online: false, updatedAt: nowIso() } }
    );

    if (res.modifiedCount !== 1) return;

    await events.insertOne({
      deviceId: DEVICE_ID,
      type: "device_offline",
      raw: null,
      payload: safeForMongo({ type: "device_offline" }),
      ts: new Date(),
    });

    if (!seenOnlineThisSession) return;

    await sendAlertOnce(DEVICE_ID,`${DEVICE_ID}:offline`, {
      subject: `⚠️ Device offline (${DEVICE_ID})`,
      text: `Device is OFFLINE\n\nDevice: ${DEVICE_ID}\nNo heartbeat received for ${OFFLINE_AFTER_SECONDS} seconds.\nTime: ${new Date().toLocaleString()}\n\nPlease check power or network connection.`,
      html: buildEmailHtml({
        title: "Device Offline",
        badge: "OFFLINE",
        lines: [
          `No heartbeat detected for ${OFFLINE_AFTER_SECONDS} seconds.`,
          "The feeder is currently unreachable.",
          "Please check device power or Wi-Fi connection.",
        ],
        meta: {
          Device: DEVICE_ID,
          "Last Seen": device?.lastSeen ? new Date(device.lastSeen).toLocaleString() : "Unknown",
          RSSI: typeof device?.rssi === "number" ? `${device.rssi} dBm` : "—",
          IP: device?.ip || "—",
          Time: new Date().toLocaleString(),
        },
      }),
    });

    console.log("[NOTIFY] device offline");
  }, OFFLINE_CHECK_EVERY_MS);

  // ---- Missed feeding detector ----
  setInterval(async () => {
    const device = await devices.findOne({ deviceId: DEVICE_ID });
    if (!device) return;

    const csv = device.scheduleCsv || "";
    const list = scheduleList(csv);
    if (list.length === 0) return;

    const now = new Date();
    const lastSched = computeLastScheduledEpoch(now, csv);
    if (!lastSched) return;

    const scheduledAt = lastSched.epoch;
    const dueAt = new Date(scheduledAt.getTime() + MISSED_GRACE_SECONDS * 1000);

    if (now < dueAt) return;

    const lastFeed = device.lastFeed ? new Date(device.lastFeed) : null;
    if (lastFeed && lastFeed.getTime() >= scheduledAt.getTime()) return;

    const key = `${scheduledAt.getFullYear()}-${String(scheduledAt.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(scheduledAt.getDate()).padStart(2, "0")} ${lastSched.hhmm}`;

    if (device.lastMissedKey === key) return;

    await sendAlertOnce(DEVICE_ID,`${DEVICE_ID}:missed:${key}`, {
      subject: `❗ Missed feeding (${DEVICE_ID}) at ${lastSched.hhmm}`,
      text: `Missed feeding.\nDevice: ${DEVICE_ID}\nScheduled: ${fmtTime(
        scheduledAt
      )}\nChecked: ${fmtTime(now)}`,
      html: buildEmailHtml({
        title: "Missed feeding",
        badge: "MISSED",
        lines: [
          `No feed_done after scheduled time + ${MISSED_GRACE_SECONDS}s grace.`,
          "Check power, network, food jam, or servo.",
        ],
        meta: {
          Device: DEVICE_ID,
          Scheduled: fmtTime(scheduledAt),
          "Grace (sec)": String(MISSED_GRACE_SECONDS),
          Checked: fmtTime(now),
          "Last feed": fmtTime(device.lastFeed),
          "Last seen": fmtTime(device.lastSeen),
          RSSI: typeof device.rssi === "number" ? `${device.rssi} dBm` : "—",
          IP: device.ip || "—",
        },
      }),
    });

    await devices.updateOne(
      { deviceId: DEVICE_ID },
      { $set: { lastMissedAt: now, lastMissedKey: key, updatedAt: nowIso() } }
    );

    await events.insertOne({
      deviceId: DEVICE_ID,
      type: "missed_feeding",
      raw: null,
      payload: safeForMongo({
        type: "missed_feeding",
        scheduledAt: scheduledAt.toISOString(), // ✅ safer than Date object in nested payload
        graceSeconds: MISSED_GRACE_SECONDS,
        key,
      }),
      ts: now,
    });

    console.log("[NOTIFY] missed feeding", key);
  }, MISSED_CHECK_EVERY_MS);

  // ---- REST API ----
  app.get("/api/health", (req, res) => res.json({ ok: true, ts: nowIso() }));

  app.get("/api/devices/:deviceId/state", async (req, res) => {
    const deviceId = req.params.deviceId;
    const doc = await devices.findOne({ deviceId }, { projection: { _id: 0 } });
    if (!doc) return res.status(404).json({ error: "Device not found" });
    res.json(doc);
  });

  app.get("/api/devices/:deviceId/events", async (req, res) => {
    const deviceId = req.params.deviceId;
    const limit = Math.min(Number(req.query.limit || 50), 200);

    const list = await events
      .find({ deviceId }, { projection: { _id: 0 } })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();

    res.json({ deviceId, items: list });
  });

  app.post("/api/devices/:deviceId/schedule", async (req, res) => {
    const deviceId = req.params.deviceId;
    const { scheduleCsv } = req.body || {};
    if (typeof scheduleCsv !== "string") {
      return res.status(400).json({ error: "scheduleCsv required" });
    }

    await devices.updateOne(
      { deviceId },
      { $set: { scheduleCsv, updatedAt: nowIso() } },
      { upsert: true }
    );

    res.json({ ok: true });
  });

  app.post("/api/test-email", async (req, res) => {
    await sendAlertEmail({
      subject: "Test email (Fish Feeder)",
      text: "Hello from Fish Feeder backend.",
      html: buildEmailHtml({
        title: "Test email",
        badge: "TEST",
        lines: ["HTML email works."],
        meta: { Time: fmtTime(new Date()), Device: DEVICE_ID },
      }),
    });
    res.json({ ok: true });
  });

  app.post("/api/devices/:deviceId/config", async (req, res) => {
    const deviceId = req.params.deviceId;
    const cfg = req.body || {};

    const clean = {
      idleAngle: clampInt(cfg.idleAngle, 0, 180, 0),
      feedAngle: clampInt(cfg.feedAngle, 0, 180, 150),
      feedMs: clampInt(cfg.feedMs, 50, 10000, 500),
      oledOn: !!cfg.oledOn,
      emailNotify: !!cfg.emailNotify,
    };

    await devices.updateOne(
      { deviceId },
      { $set: { config: clean, updatedAt: nowIso() } },
      { upsert: true }
    );

    res.json({ ok: true, config: clean });
  });

  function clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  }

  app.listen(PORT, () => console.log(`API running on :${PORT}`));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
