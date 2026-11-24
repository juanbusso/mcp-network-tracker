import {
  assignDeviceToPerson,
  createPerson,
  getAllDevices,
  getDevice,
  getDeviceHistory,
  getPeoplePresence,
  getPersonHistory,
  renameDevice
} from './db.mjs';
import { runNetworkScan } from './scanner.mjs';

export async function executeTool(name, args = {}) {
  switch (name) {
    case 'network_get_status': {
      const filter = args.filter || 'online';
      const people = getPeoplePresence();
      const devices = getAllDevices(filter);
      return {
        network: args.network || 'local',
        people_presence: people,
        devices_count: devices.length,
        devices: devices.map((d) => ({
          mac: d.mac,
          ip: d.ip,
          name: d.custom_name || d.vendor || 'Dispositivo',
          vendor: d.vendor,
          person: d.person_name || null,
          is_online: Boolean(d.is_online),
          last_seen: d.last_seen
        }))
      };
    }

    case 'network_scan_now': {
      const scanResult = await runNetworkScan();
      return { network: args.network || 'local', ...scanResult };
    }

    case 'network_list_people': {
      return { network: args.network || 'local', people: getPeoplePresence() };
    }

    case 'network_add_person': {
      const person = createPerson(args.name, args.notes);
      return { network: args.network || 'local', success: true, person };
    }

    case 'network_assign_device': {
      const res = assignDeviceToPerson(args.mac, args.person);
      return { network: args.network || 'local', success: true, ...res };
    }

    case 'network_rename_device': {
      const dev = renameDevice(args.mac, args.custom_name);
      return { network: args.network || 'local', success: true, device: dev };
    }

    case 'network_get_device_history': {
      const events = getDeviceHistory(args.mac || null, args.limit || 50);
      return { network: args.network || 'local', events_count: events.length, events };
    }

    case 'network_get_person_history': {
      const result = getPersonHistory(args.person, args.limit || 50);
      return { network: args.network || 'local', ...result };
    }

    default:
      throw new Error(`Herramienta desconocida: ${name}`);
  }
}

// If executed directly from CLI (e.g. over SSH)
if (process.argv[1] && process.argv[1].endsWith('tool_runner.mjs')) {
  const toolName = process.argv[2];
  let toolArgs = {};
  const raw = process.argv[3];
  
  if (raw) {
    try {
      if (raw.startsWith('{')) {
        toolArgs = JSON.parse(raw);
      } else {
        toolArgs = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      }
    } catch (err) {
      try {
        toolArgs = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      } catch (err2) {
        console.error('Error parsing JSON/base64 args:', err2.message);
        process.exit(1);
      }
    }
  }

  executeTool(toolName, toolArgs)
    .then((result) => {
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
    })
    .catch((err) => {
      console.error(JSON.stringify({ error: err.message }));
      process.exit(1);
    });
}
