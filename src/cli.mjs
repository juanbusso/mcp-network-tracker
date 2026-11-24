#!/usr/bin/env node

import {
  assignDeviceToPerson,
  createPerson,
  getAllDevices,
  getDevice,
  getDeviceHistory,
  getPeople,
  getPeoplePresence,
  getPersonByName,
  getPersonHistory,
  renameDevice
} from './db.mjs';
import { runNetworkScan } from './scanner.mjs';

// ANSI color helpers
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  white: '\x1b[37m'
};

function formatTime(isoString) {
  if (!isoString) return 'Nunca';
  const d = new Date(isoString);
  return d.toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function printUsage() {
  console.log(`
${colors.bold}${colors.cyan}🛰️  Network Tracker CLI - Monitor de Red y Personas${colors.reset}

${colors.bold}Uso:${colors.reset}
  node src/cli.mjs <comando> [argumentos]

${colors.bold}Comandos disponibles:${colors.reset}
  ${colors.green}scan${colors.reset}                          Escanea la red inmediatamente y actualiza la DB.
  ${colors.green}status${colors.reset}                        Muestra los dispositivos conectados y personas presentes.
  ${colors.green}devices [online|offline|all]${colors.reset}  Lista todos los dispositivos registrados.
  ${colors.green}people${colors.reset}                        Lista las personas registradas y su estado de presencia.
  ${colors.green}person add <nombre> [notas]${colors.reset}   Registra una nueva persona.
  ${colors.green}person history <nombre>${colors.reset}       Muestra el historial de presencia de una persona.
  ${colors.green}assign <mac> <nombre>${colors.reset}         Vincula un dispositivo (MAC) a una persona.
  ${colors.green}rename <mac> <nombre>${colors.reset}         Asigna un alias amigable a un dispositivo.
  ${colors.green}history [mac]${colors.reset}                 Muestra el historial de eventos (conexiones/desconexiones).
`);
}

async function handleScan() {
  console.log(`${colors.cyan}🔍 Escaneando la red local...${colors.reset}`);
  const res = await runNetworkScan();
  console.log(`${colors.green}✔ Escaneo completado en ${res.durationMs}ms (${res.subnet})${colors.reset}`);
  console.log(`  Dispositivos activos encontrados: ${colors.bold}${res.totalDiscovered}${colors.reset}`);

  if (res.newDevices.length > 0) {
    console.log(`  ${colors.yellow}★ ${res.newDevices.length} nuevos dispositivos detectados:${colors.reset}`);
    for (const d of res.newDevices) {
      console.log(`    - IP: ${d.ip.padEnd(15)} MAC: ${d.mac} (${d.vendor})`);
    }
  }

  if (res.reconnectedDevices.length > 0) {
    console.log(`  ${colors.green}↑ ${res.reconnectedDevices.length} dispositivos se reconectaron${colors.reset}`);
  }

  if (res.wentOffline.length > 0) {
    console.log(`  ${colors.red}↓ ${res.wentOffline.length} dispositivos se desconectaron${colors.reset}`);
    for (const d of res.wentOffline) {
      console.log(`    - IP: ${(d.ip || '').padEnd(15)} MAC: ${d.mac} (${d.custom_name || d.vendor})`);
    }
  }
}

function handleStatus() {
  const peoplePresence = getPeoplePresence();
  const onlineDevices = getAllDevices('online');
  const offlineDevices = getAllDevices('offline');

  console.log(`\n${colors.bold}${colors.cyan}══════════════════════════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(` ${colors.bold}🛰️  ESTADO DE LA RED Y PRESENCIA${colors.reset}`);
  console.log(`${colors.cyan}══════════════════════════════════════════════════════════════════════════════════${colors.reset}\n`);

  // Section 1: People
  console.log(`${colors.bold}👥 PERSONAS / PRESENCIA:${colors.reset}`);
  if (peoplePresence.length === 0) {
    console.log(`  ${colors.dim}No hay personas registradas. Usa 'person add <nombre>' y luego 'assign <mac> <nombre>'${colors.reset}`);
  } else {
    for (const p of peoplePresence) {
      const statusIcon = p.is_present ? `${colors.green}🟢 PRESENTE (En casa)${colors.reset}` : `${colors.red}🔴 AUSENTE${colors.reset}`;
      console.log(`  • ${colors.bold}${p.name.padEnd(15)}${colors.reset} [${statusIcon}] - Última vez visto: ${formatTime(p.last_seen)}`);
      for (const d of p.devices) {
        const dIcon = d.is_online ? `${colors.green}●${colors.reset}` : `${colors.dim}○${colors.reset}`;
        console.log(`      ${dIcon} ${d.name.padEnd(25)} IP: ${(d.ip || 'N/A').padEnd(15)} MAC: ${d.mac} (${d.vendor})`);
      }
    }
  }

  // Section 2: Online Devices
  console.log(`\n${colors.bold}📡 DISPOSITIVOS CONECTADOS AHORA (${onlineDevices.length}):${colors.reset}`);
  console.log(`${colors.dim}${'IP'.padEnd(16)} ${'MAC'.padEnd(19)} ${'PERSONA'.padEnd(16)} ${'NOMBRE / FABRICANTE'.padEnd(35)}${colors.reset}`);
  console.log(`${colors.dim}─`.repeat(86) + `${colors.reset}`);

  for (const d of onlineDevices) {
    const personStr = d.person_name ? `${colors.cyan}${d.person_name}${colors.reset}` : `${colors.dim}(Sin asignar)${colors.reset}`;
    const nameStr = d.custom_name ? `${colors.bold}${d.custom_name}${colors.reset} (${d.vendor})` : d.vendor || 'Desconocido';
    console.log(`${(d.ip || '').padEnd(16)} ${d.mac.padEnd(19)} ${personStr.padEnd(25)} ${nameStr}`);
  }

  if (offlineDevices.length > 0) {
    console.log(`\n${colors.dim}💤 ${offlineDevices.length} dispositivos registrados están actualmente desconectados.${colors.reset}`);
  }
  console.log();
}

function handleDevices(filter = 'all') {
  const devices = getAllDevices(filter);
  console.log(`\n${colors.bold}📱 Dispositivos (${filter}): ${devices.length}${colors.reset}\n`);
  for (const d of devices) {
    const status = d.is_online ? `${colors.green}ONLINE${colors.reset}` : `${colors.red}OFFLINE${colors.reset}`;
    const person = d.person_name ? `Persona: ${colors.cyan}${d.person_name}${colors.reset}` : `(Sin persona)`;
    const alias = d.custom_name ? `Alias: "${colors.bold}${d.custom_name}${colors.reset}"` : '';
    console.log(`  [${status}] IP: ${(d.ip || 'N/A').padEnd(15)} MAC: ${d.mac} | ${person} | ${d.vendor} ${alias}`);
    console.log(`    ${colors.dim}Visto por primera vez: ${formatTime(d.first_seen)} | Última vez: ${formatTime(d.last_seen)}${colors.reset}`);
  }
  console.log();
}

function handlePeople() {
  const presence = getPeoplePresence();
  console.log(`\n${colors.bold}👥 Personas Registradas (${presence.length}):${colors.reset}\n`);
  for (const p of presence) {
    const state = p.is_present ? `${colors.green}PRESENTE${colors.reset}` : `${colors.red}AUSENTE${colors.reset}`;
    console.log(`  ${colors.bold}${p.name}${colors.reset} [${state}] (${p.device_count} dispositivos asignados)`);
    if (p.notes) console.log(`    Notas: ${p.notes}`);
    console.log(`    Última vez visto en red: ${formatTime(p.last_seen)}`);
    for (const d of p.devices) {
      const devState = d.is_online ? `${colors.green}ONLINE${colors.reset}` : `${colors.dim}OFFLINE${colors.reset}`;
      console.log(`    - [${devState}] ${d.name} (${d.mac}) IP: ${d.ip || 'N/A'}`);
    }
    console.log();
  }
}

function handleAddPerson(name, notes) {
  if (!name) {
    console.error(`${colors.red}Error: Debes especificar el nombre de la persona.${colors.reset}`);
    process.exit(1);
  }
  const person = createPerson(name, notes);
  console.log(`${colors.green}✔ Persona creada exitosamente:${colors.reset} ${colors.bold}${person.name}${colors.reset} (ID: ${person.id})`);
}

function handleAssign(mac, personName) {
  if (!mac || !personName) {
    console.error(`${colors.red}Error: Uso: assign <mac> <nombre_persona>${colors.reset}`);
    process.exit(1);
  }
  const res = assignDeviceToPerson(mac, personName);
  console.log(`${colors.green}✔ Dispositivo ${res.mac} asignado a:${colors.reset} ${colors.bold}${res.person ? res.person.name : 'Nadie'}${colors.reset}`);
}

function handleRename(mac, name) {
  if (!mac || !name) {
    console.error(`${colors.red}Error: Uso: rename <mac> <alias>${colors.reset}`);
    process.exit(1);
  }
  const dev = renameDevice(mac, name);
  console.log(`${colors.green}✔ Dispositivo ${mac} renombrado a:${colors.reset} "${colors.bold}${dev.custom_name}${colors.reset}"`);
}

function handleHistory(mac = null) {
  const events = getDeviceHistory(mac, 50);
  console.log(`\n${colors.bold}📜 Historial de Conexiones ${mac ? `para MAC ${mac}` : '(Últimos 50 eventos)'}:${colors.reset}\n`);

  for (const e of events) {
    let typeColor = colors.white;
    let icon = '•';
    if (e.event_type === 'ONLINE') {
      typeColor = colors.green;
      icon = '▲';
    } else if (e.event_type === 'OFFLINE') {
      typeColor = colors.red;
      icon = '▼';
    } else if (e.event_type === 'NEW_DEVICE') {
      typeColor = colors.yellow;
      icon = '★';
    } else if (e.event_type === 'IP_CHANGED') {
      typeColor = colors.blue;
      icon = '⟳';
    }

    const deviceName = e.custom_name || e.vendor || e.mac;
    const personStr = e.person_name ? `[${colors.cyan}${e.person_name}${colors.reset}]` : '';
    console.log(`  ${colors.dim}${formatTime(e.timestamp)}${colors.reset} ${typeColor}${icon} ${e.event_type.padEnd(11)}${colors.reset} ${deviceName.padEnd(25)} ${personStr} ${(e.ip || '').padEnd(15)} ${e.details || ''}`);
  }
  console.log();
}

function handlePersonHistory(personName) {
  if (!personName) {
    console.error(`${colors.red}Error: Debes especificar el nombre de la persona.${colors.reset}`);
    process.exit(1);
  }
  const { person, events } = getPersonHistory(personName, 50);
  if (!person) {
    console.error(`${colors.red}No se encontró la persona "${personName}".${colors.reset}`);
    process.exit(1);
  }

  console.log(`\n${colors.bold}📜 Historial de Presencia para ${colors.cyan}${person.name}${colors.reset} (ID: ${person.id}):\n`);
  if (events.length === 0) {
    console.log(`  ${colors.dim}No hay registros de eventos para los dispositivos de esta persona.${colors.reset}\n`);
    return;
  }

  for (const e of events) {
    let typeColor = e.event_type === 'ONLINE' ? colors.green : e.event_type === 'OFFLINE' ? colors.red : colors.white;
    const icon = e.event_type === 'ONLINE' ? '🟢 Conectado' : e.event_type === 'OFFLINE' ? '🔴 Desconectado' : '• ' + e.event_type;
    const dev = e.custom_name || e.vendor || e.mac;
    console.log(`  ${colors.dim}${formatTime(e.timestamp)}${colors.reset} ${typeColor}${icon.padEnd(18)}${colors.reset} Dispositivo: ${dev} (${e.ip || 'N/A'}) - ${e.details || ''}`);
  }
  console.log();
}

// Command dispatcher
const args = process.argv.slice(2);
const command = args[0] ? args[0].toLowerCase() : null;

switch (command) {
  case 'scan':
    await handleScan();
    break;
  case 'status':
    handleStatus();
    break;
  case 'devices':
    handleDevices(args[1]);
    break;
  case 'people':
    handlePeople();
    break;
  case 'person':
    if (args[1] === 'add') handleAddPerson(args[2], args.slice(3).join(' '));
    else if (args[1] === 'assign') handleAssign(args[2], args[3]);
    else if (args[1] === 'history') handlePersonHistory(args[2]);
    else handlePeople();
    break;
  case 'assign':
    handleAssign(args[1], args[2]);
    break;
  case 'rename':
    handleRename(args[1], args.slice(2).join(' '));
    break;
  case 'history':
    handleHistory(args[1]);
    break;
  default:
    printUsage();
    break;
}
