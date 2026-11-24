import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDevice } from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "..", "data", "alerts_state.json");

// WhatsApp alerts are opt-in: nothing is sent unless WHATSAPP_TARGET_CHAT is set.
// WHATSAPP_API_URL is the base URL of an HTTP bridge exposing POST /api/send-message.
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL || "http://127.0.0.1:3333";
const WHATSAPP_TARGET_CHAT = process.env.WHATSAPP_TARGET_CHAT || "";
const WHATSAPP_ACCOUNT = process.env.WHATSAPP_ACCOUNT || "";

// Comma-separated person names (as registered with `person add`) that trigger a once-per-day arrival alert.
const ARRIVAL_ALERT_PEOPLE = (process.env.NETWORK_TRACKER_ARRIVAL_ALERTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// IANA timezone for alert timestamps and the "once per day" boundary (defaults to system timezone).
const TIMEZONE = process.env.NETWORK_TRACKER_TIMEZONE || undefined;

export function loadAlertsState() {
  const empty = { last_arrival_by_person: {}, notified_new_macs: [] };
  try {
    if (fs.existsSync(STATE_FILE)) {
      return { ...empty, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) };
    }
  } catch (err) {
    console.error("[Notifier] Error leyendo " + STATE_FILE + ":", err.message);
  }
  return empty;
}

export function saveAlertsState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("[Notifier] Error guardando " + STATE_FILE + ":", err.message);
  }
}

export async function sendWhatsAppMessage(text) {
  if (!WHATSAPP_TARGET_CHAT) {
    return { success: false, error: "WHATSAPP_TARGET_CHAT not configured" };
  }
  try {
    const res = await fetch(new URL("/api/send-message", WHATSAPP_API_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(WHATSAPP_ACCOUNT ? { account: WHATSAPP_ACCOUNT } : {}),
        to: WHATSAPP_TARGET_CHAT,
        text
      })
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("[Notifier] WhatsApp API respondió " + res.status + ": " + body);
      return { success: false, error: "HTTP " + res.status, body };
    }
    return await res.json();
  } catch (err) {
    console.error("[Notifier] Error al enviar WhatsApp:", err.message);
    return { success: false, error: err.message };
  }
}

export async function processScanAlerts(scanResult) {
  if (!WHATSAPP_TARGET_CHAT) return;
  if (!scanResult || !scanResult.networkReady) return;

  const state = loadAlertsState();
  const now = new Date();
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(now);
  const timeStr = now.toLocaleTimeString(undefined, {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  // 1. Alerta de nuevo dispositivo detectado
  if (scanResult.newDevices && scanResult.newDevices.length > 0) {
    for (const dev of scanResult.newDevices) {
      if (!state.notified_new_macs.includes(dev.mac)) {
        const msg = [
          "🔔 *Nuevo Dispositivo Detectado en la Red*",
          "────────────────────",
          "• *IP:* " + (dev.ip || "Asignando..."),
          "• *MAC:* `" + dev.mac + "`",
          "• *Fabricante:* " + (dev.vendor || "Desconocido"),
          "• *Hora:* " + timeStr + " hs",
          "",
          "_Si es un dispositivo conocido, podés pedirme que lo renombre o asigne a una persona._"
        ].join("\n");

        console.log("[Notifier] Enviando alerta de nuevo dispositivo: " + dev.mac + " (" + dev.ip + ")");
        await sendWhatsAppMessage(msg);
        state.notified_new_macs.push(dev.mac);

        if (state.notified_new_macs.length > 300) {
          state.notified_new_macs = state.notified_new_macs.slice(-300);
        }
        saveAlertsState(state);
      }
    }
  }

  // 2. Alerta de llegada (una vez por día) para las personas en NETWORK_TRACKER_ARRIVAL_ALERTS
  if (ARRIVAL_ALERT_PEOPLE.length === 0) return;

  const devicesToCheck = [
    ...(scanResult.reconnectedDevices || []),
    ...(scanResult.newDevices || [])
  ];

  for (const dev of devicesToCheck) {
    const fullDev = getDevice(dev.mac);
    if (!fullDev || !fullDev.person_name) continue;

    const personKey = fullDev.person_name.toLowerCase();
    if (!ARRIVAL_ALERT_PEOPLE.includes(personKey)) continue;
    if (state.last_arrival_by_person[personKey] === todayStr) continue;

    const msg = [
      "🏡 *" + fullDev.person_name + " acaba de llegar*",
      "────────────────────",
      "• *Hora de llegada:* " + timeStr + " hs",
      "• *Dispositivo:* " + (fullDev.custom_name || fullDev.vendor || fullDev.mac) + " (" + fullDev.ip + ")",
      "",
      "_Registrado automáticamente por Network Tracker._"
    ].join("\n");

    console.log("[Notifier] 🏡 " + fullDev.person_name + " llegó a las " + timeStr + " hs. Enviando alerta a WhatsApp...");
    await sendWhatsAppMessage(msg);

    state.last_arrival_by_person[personKey] = todayStr;
    saveAlertsState(state);
  }
}
