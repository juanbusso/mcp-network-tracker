import fs from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { handleMissingDevices, normalizeMac, processScannedDevice } from './db.mjs';
import { resolveVendor } from './vendor.mjs';

const isDarwin = process.platform === 'darwin';

// Get the local private IPv4 /24 subnet prefix (e.g. "10.0.0")
export function detectSubnetPrefix() {
  try {
    let out = '';
    if (isDarwin) {
      out = execSync('ifconfig').toString();
    } else {
      try {
        out = execSync('ip -4 addr show').toString();
      } catch {
        out = execSync('ifconfig 2>/dev/null || hostname -I').toString();
      }
    }
    
    // Only RFC 1918 private ranges are considered; link-local, loopback and CGNAT/VPN (e.g. Tailscale) addresses are ignored
    const match192 = out.match(/inet (?:addr:)?(192\.168\.\d+)\.(\d+)/);
    if (match192) return match192[1];

    const match10 = out.match(/inet (?:addr:)?(10\.\d+\.\d+)\.(\d+)/);
    if (match10) return match10[1];

    const match172 = out.match(/inet (?:addr:)?(172\.(?:1[6-9]|2\d|3[0-1])\.\d+)\.(\d+)/);
    if (match172) return match172[1];
  } catch (err) {
    // Suppress errors during network startup
  }
  return null;
}

// Perform ping sweep across the /24 subnet
export async function pingSweepSubnet(prefix) {
  if (!prefix) return;
  const promises = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `${prefix}.${i}`;
    promises.push(
      new Promise((resolve) => {
        const args = isDarwin
          ? ['-c', '1', '-t', '1', '-W', '350', ip]
          : ['-c', '1', '-w', '1', ip];
        const p = spawn('ping', args);
        p.on('close', () => resolve(ip));
        p.on('error', () => resolve(ip));
      })
    );
  }
  await Promise.all(promises);
}

// Parse ARP cache (macOS arp -an OR Linux /proc/net/arp)
export function readArpTable(prefix = null) {
  const devices = [];
  try {
    if (!isDarwin && fs.existsSync('/proc/net/arp')) {
      const content = fs.readFileSync('/proc/net/arp', 'utf-8');
      const lines = content.split('\n').slice(1);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 6) {
          const ip = parts[0];
          const flags = parts[2];
          const rawMac = parts[3];
          const dev = parts[5];
          
          if (dev && (dev.startsWith('docker') || dev.startsWith('br-') || dev.startsWith('veth') || dev.startsWith('tailscale'))) {
            continue;
          }

          if (prefix && !ip.startsWith(prefix + '.')) {
            continue;
          }
          
          if (flags !== '0x0' && rawMac && rawMac !== '00:00:00:00:00:00') {
            const mac = normalizeMac(rawMac);
            if (mac !== 'ff:ff:ff:ff:ff:ff' && !mac.startsWith('01:00:5e')) {
              devices.push({
                ip,
                mac,
                vendor: resolveVendor(mac)
              });
            }
          }
        }
      }
      return devices;
    }

    const out = execSync('arp -an 2>/dev/null || ip neighbor').toString();
    const lines = out.split('\n');

    for (const line of lines) {
      const matchMac = line.match(/\(([\d\.]+)\) at ([0-9a-fA-F:]+) on/);
      if (matchMac && !line.includes('(incomplete)')) {
        const ip = matchMac[1];
        const rawMac = matchMac[2];
        const mac = normalizeMac(rawMac);

        if (prefix && !ip.startsWith(prefix + '.')) {
          continue;
        }

        if (mac !== 'ff:ff:ff:ff:ff:ff' && !mac.startsWith('01:00:5e')) {
          devices.push({
            ip,
            mac,
            vendor: resolveVendor(mac)
          });
        }
      } else {
        const matchIpNeigh = line.match(/^([\d\.]+)\s+dev\s+(\S+)\s+lladdr\s+([0-9a-fA-F:]+)/);
        if (matchIpNeigh && !line.includes('FAILED')) {
          const ip = matchIpNeigh[1];
          const dev = matchIpNeigh[2];
          const rawMac = matchIpNeigh[3];
          const mac = normalizeMac(rawMac);

          if (dev && (dev.startsWith('docker') || dev.startsWith('br-') || dev.startsWith('veth') || dev.startsWith('tailscale'))) {
            continue;
          }

          if (prefix && !ip.startsWith(prefix + '.')) {
            continue;
          }

          if (mac !== 'ff:ff:ff:ff:ff:ff' && !mac.startsWith('01:00:5e')) {
            devices.push({
              ip,
              mac,
              vendor: resolveVendor(mac)
            });
          }
        }
      }
    }
  } catch (err) {
    // Suppress errors during network startup
  }
  return devices;
}

// Full scan orchestration
export async function runNetworkScan(customPrefix = null, missingTolerance = 2) {
  const startTime = Date.now();
  const prefix = customPrefix || detectSubnetPrefix();

  if (!prefix) {
    return {
      networkReady: false,
      subnet: null,
      durationMs: 0,
      timestamp: new Date().toISOString(),
      totalDiscovered: 0,
      newDevices: [],
      reconnectedDevices: [],
      updatedDevices: [],
      wentOffline: [],
      message: 'Esperando conexión Wi-Fi / Ethernet e IP del router...'
    };
  }

  // 1. Fast ping sweep to populate ARP cache
  await pingSweepSubnet(prefix);

  // 2. Read live devices from ARP cache
  const discoveredDevices = readArpTable(prefix);

  // Guard against router rebooting / empty ARP table:
  // If 0 devices are found (or only the host itself), the router/modem is still booting.
  // We do NOT mark existing devices as offline during this period to avoid false alarms.
  if (discoveredDevices.length === 0) {
    return {
      networkReady: false,
      subnet: `${prefix}.0/24`,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      totalDiscovered: 0,
      newDevices: [],
      reconnectedDevices: [],
      updatedDevices: [],
      wentOffline: [],
      message: 'Red conectada pero router/dispositivos aún iniciando...'
    };
  }

  // 3. Process each device in SQLite
  const results = {
    networkReady: true,
    subnet: `${prefix}.0/24`,
    durationMs: 0,
    timestamp: new Date().toISOString(),
    totalDiscovered: discoveredDevices.length,
    newDevices: [],
    reconnectedDevices: [],
    updatedDevices: [],
    wentOffline: []
  };

  const seenMacs = [];

  for (const dev of discoveredDevices) {
    seenMacs.push(dev.mac);
    const processResult = processScannedDevice(dev);
    if (processResult.type === 'NEW') {
      results.newDevices.push(dev);
    } else if (processResult.type === 'RECONNECTED') {
      results.reconnectedDevices.push(dev);
    } else {
      results.updatedDevices.push(dev);
    }
  }

  // 4. Mark missing devices offline only when network is healthy and scanning normally
  results.wentOffline = handleMissingDevices(seenMacs, missingTolerance);
  results.durationMs = Date.now() - startTime;

  return results;
}

