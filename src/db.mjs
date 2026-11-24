import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'network_tracker.db');
let dbInstance = null;

export function getDatabase() {
  if (dbInstance) return dbInstance;

  dbInstance = new DatabaseSync(dbPath);

  // Enable WAL mode for better concurrency between scanner daemon and MCP/CLI
  dbInstance.exec(`PRAGMA journal_mode = WAL;`);
  dbInstance.exec(`PRAGMA foreign_keys = ON;`);

  // Initialize schema
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      mac TEXT PRIMARY KEY,
      person_id INTEGER,
      ip TEXT,
      custom_name TEXT,
      vendor TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      is_online INTEGER DEFAULT 1,
      last_status_change TEXT NOT NULL,
      missed_scans INTEGER DEFAULT 0,
      FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS device_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mac TEXT NOT NULL,
      event_type TEXT NOT NULL, -- 'NEW_DEVICE', 'ONLINE', 'OFFLINE', 'IP_CHANGED'
      ip TEXT,
      details TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (mac) REFERENCES devices(mac) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_device_history_mac ON device_history(mac);
    CREATE INDEX IF NOT EXISTS idx_device_history_timestamp ON device_history(timestamp);
    CREATE INDEX IF NOT EXISTS idx_devices_person ON devices(person_id);
  `);

  return dbInstance;
}

// Normalize MAC to xx:xx:xx:xx:xx:xx lowercase
export function normalizeMac(mac) {
  if (!mac) return '';
  return mac
    .split(':')
    .map((part) => part.padStart(2, '0').toLowerCase())
    .join(':');
}

// Record history event
export function logHistoryEvent(mac, event_type, ip = null, details = null, timestamp = null) {
  const db = getDatabase();
  const time = timestamp || new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO device_history (mac, event_type, ip, details, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(mac, event_type, ip, details, time);
}

// Upsert device from scan
export function processScannedDevice(deviceData) {
  const db = getDatabase();
  const mac = normalizeMac(deviceData.mac);
  const { ip, vendor } = deviceData;
  const now = new Date().toISOString();

  const getStmt = db.prepare(`SELECT * FROM devices WHERE mac = ?`);
  const existing = getStmt.get(mac);

  if (!existing) {
    // Brand new device
    const insertStmt = db.prepare(`
      INSERT INTO devices (mac, ip, vendor, first_seen, last_seen, is_online, last_status_change, missed_scans)
      VALUES (?, ?, ?, ?, ?, 1, ?, 0)
    `);
    insertStmt.run(mac, ip, vendor || 'Desconocido', now, now, now);
    logHistoryEvent(mac, 'NEW_DEVICE', ip, `Nuevo dispositivo detectado (${vendor || 'Desconocido'})`, now);
    logHistoryEvent(mac, 'ONLINE', ip, 'Conexión inicial', now);
    return { type: 'NEW', mac, ip, vendor };
  } else {
    // Existing device
    const updates = [];
    const params = [];
    let stateChanged = false;

    // Check online status transition
    if (existing.is_online === 0) {
      updates.push('is_online = 1', 'last_status_change = ?', 'missed_scans = 0');
      params.push(now);
      logHistoryEvent(mac, 'ONLINE', ip, 'Dispositivo reconectado', now);
      stateChanged = true;
    } else {
      updates.push('missed_scans = 0');
    }

    // Check IP change
    if (existing.ip !== ip) {
      updates.push('ip = ?');
      params.push(ip);
      logHistoryEvent(mac, 'IP_CHANGED', ip, `IP cambió de ${existing.ip} a ${ip}`, now);
    }

    // Update vendor if we now have a better match
    if (vendor && (!existing.vendor || existing.vendor === 'Desconocido')) {
      updates.push('vendor = ?');
      params.push(vendor);
    }

    updates.push('last_seen = ?');
    params.push(now);

    params.push(mac);
    const updateStmt = db.prepare(`UPDATE devices SET ${updates.join(', ')} WHERE mac = ?`);
    updateStmt.run(...params);

    return { type: stateChanged ? 'RECONNECTED' : 'UPDATED', mac, ip };
  }
}

// Mark devices missing in current scan
export function handleMissingDevices(seenMacs, toleranceThreshold = 2) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const normalizedSeen = new Set(seenMacs.map(normalizeMac));

  const onlineStmt = db.prepare(`SELECT * FROM devices WHERE is_online = 1`);
  const onlineDevices = onlineStmt.all();

  const wentOffline = [];

  for (const dev of onlineDevices) {
    if (!normalizedSeen.has(dev.mac)) {
      const newMissed = (dev.missed_scans || 0) + 1;
      if (newMissed >= toleranceThreshold) {
        // Mark offline
        const offlineStmt = db.prepare(`
          UPDATE devices 
          SET is_online = 0, missed_scans = ?, last_status_change = ?
          WHERE mac = ?
        `);
        offlineStmt.run(newMissed, now, dev.mac);
        logHistoryEvent(dev.mac, 'OFFLINE', dev.ip, `Desconectado (sin respuesta tras ${newMissed} escaneos)`, now);
        wentOffline.push(dev);
      } else {
        const updateMissed = db.prepare(`UPDATE devices SET missed_scans = ? WHERE mac = ?`);
        updateMissed.run(newMissed, dev.mac);
      }
    }
  }

  return wentOffline;
}

// Person management
export function createPerson(name, notes = null) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const stmt = db.prepare(`INSERT INTO people (name, notes, created_at) VALUES (?, ?, ?)`);
  stmt.run(name.trim(), notes, now);
  return getPersonByName(name.trim());
}

export function getPeople() {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT * FROM people ORDER BY name ASC`);
  return stmt.all();
}

export function getPersonByName(name) {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT * FROM people WHERE name = ? COLLATE NOCASE`);
  return stmt.get(name.trim());
}

export function getPersonById(id) {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT * FROM people WHERE id = ?`);
  return stmt.get(id);
}

export function assignDeviceToPerson(mac, personIdOrName) {
  const db = getDatabase();
  const normalized = normalizeMac(mac);
  let person = null;

  if (typeof personIdOrName === 'number' || /^\d+$/.test(personIdOrName)) {
    person = getPersonById(Number(personIdOrName));
  } else if (personIdOrName) {
    person = getPersonByName(personIdOrName);
    if (!person) {
      person = createPerson(personIdOrName);
    }
  }

  const personId = person ? person.id : null;
  const stmt = db.prepare(`UPDATE devices SET person_id = ? WHERE mac = ?`);
  stmt.run(personId, normalized);

  return { mac: normalized, person };
}

export function renameDevice(mac, customName) {
  const db = getDatabase();
  const normalized = normalizeMac(mac);
  const stmt = db.prepare(`UPDATE devices SET custom_name = ? WHERE mac = ?`);
  stmt.run(customName ? customName.trim() : null, normalized);
  return getDevice(normalized);
}

export function getDevice(mac) {
  const db = getDatabase();
  const normalized = normalizeMac(mac);
  const stmt = db.prepare(`
    SELECT d.*, p.name AS person_name 
    FROM devices d
    LEFT JOIN people p ON d.person_id = p.id
    WHERE d.mac = ?
  `);
  return stmt.get(normalized);
}

export function getAllDevices(filter = 'all') {
  const db = getDatabase();
  let query = `
    SELECT d.*, p.name AS person_name 
    FROM devices d
    LEFT JOIN people p ON d.person_id = p.id
  `;
  if (filter === 'online') {
    query += ` WHERE d.is_online = 1`;
  } else if (filter === 'offline') {
    query += ` WHERE d.is_online = 0`;
  }
  query += ` ORDER BY d.is_online DESC, d.last_seen DESC`;

  const stmt = db.prepare(query);
  return stmt.all();
}

// Presence summary per person
export function getPeoplePresence() {
  const db = getDatabase();
  const people = getPeople();
  const results = [];

  for (const person of people) {
    const devStmt = db.prepare(`
      SELECT * FROM devices 
      WHERE person_id = ? 
      ORDER BY is_online DESC, last_seen DESC
    `);
    const devices = devStmt.all(person.id);
    const isOnline = devices.some((d) => d.is_online === 1);
    const lastSeen = devices.length > 0
      ? devices.reduce((latest, d) => (!latest || d.last_seen > latest ? d.last_seen : latest), null)
      : null;

    results.push({
      id: person.id,
      name: person.name,
      notes: person.notes,
      is_present: isOnline,
      device_count: devices.length,
      devices: devices.map((d) => ({
        mac: d.mac,
        ip: d.ip,
        name: d.custom_name || d.vendor || 'Dispositivo',
        vendor: d.vendor,
        is_online: Boolean(d.is_online),
        last_seen: d.last_seen
      })),
      last_seen: lastSeen
    });
  }

  return results;
}

// Device history query
export function getDeviceHistory(mac = null, limit = 50) {
  const db = getDatabase();
  let query = `
    SELECT h.*, d.custom_name, d.vendor, p.name AS person_name
    FROM device_history h
    LEFT JOIN devices d ON h.mac = d.mac
    LEFT JOIN people p ON d.person_id = p.id
  `;
  const params = [];

  if (mac) {
    query += ` WHERE h.mac = ?`;
    params.push(normalizeMac(mac));
  }

  query += ` ORDER BY h.timestamp DESC LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

// Person history query: aggregates all events from devices owned by this person
export function getPersonHistory(personIdOrName, limit = 50) {
  const db = getDatabase();
  let person = null;
  if (typeof personIdOrName === 'number' || /^\d+$/.test(personIdOrName)) {
    person = getPersonById(Number(personIdOrName));
  } else {
    person = getPersonByName(personIdOrName);
  }

  if (!person) return { person: null, events: [] };

  const stmt = db.prepare(`
    SELECT h.*, d.custom_name, d.vendor
    FROM device_history h
    JOIN devices d ON h.mac = d.mac
    WHERE d.person_id = ?
    ORDER BY h.timestamp DESC
    LIMIT ?
  `);

  const events = stmt.all(person.id, limit);
  return { person, events };
}
