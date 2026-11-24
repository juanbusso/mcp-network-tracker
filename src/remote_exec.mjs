import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_REMOTE_PATH = '/opt/network-tracker';

/**
 * Remote networks are optional and come from NETWORK_TRACKER_REMOTES_JSON, e.g.
 *   {"office": {"ssh": "user@office-host", "path": "/opt/network-tracker", "aliases": ["work"]}}
 * A bare string value is shorthand for {"ssh": "<value>"}. With no config, only "local" exists.
 */
function loadRemotes() {
  const raw = process.env.NETWORK_TRACKER_REMOTES_JSON;
  if (!raw) return {};

  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`NETWORK_TRACKER_REMOTES_JSON is not valid JSON: ${err.message}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('NETWORK_TRACKER_REMOTES_JSON must be a JSON object: {"name": {"ssh": "user@host"}}');
  }

  const remotes = {};
  for (const [rawName, value] of Object.entries(json)) {
    const name = rawName.toLowerCase().trim();
    if (name === 'local') throw new Error('NETWORK_TRACKER_REMOTES_JSON cannot define a remote named "local"');
    const conf = typeof value === 'string' ? { ssh: value } : value;
    if (!conf || typeof conf.ssh !== 'string' || !conf.ssh) {
      throw new Error(`NETWORK_TRACKER_REMOTES_JSON["${rawName}"] is missing an "ssh" host`);
    }
    if (conf.ssh.startsWith('-')) {
      throw new Error(`NETWORK_TRACKER_REMOTES_JSON["${rawName}"].ssh must be a host, not an option`);
    }
    remotes[name] = {
      ssh: conf.ssh,
      path: typeof conf.path === 'string' && conf.path ? conf.path : DEFAULT_REMOTE_PATH,
      aliases: Array.isArray(conf.aliases) ? conf.aliases.map((a) => String(a).toLowerCase().trim()) : []
    };
  }
  return remotes;
}

export const REMOTES = loadRemotes();
export const NETWORK_NAMES = ['local', ...Object.keys(REMOTES)];

/** Returns null for the local network, the remote config otherwise. Throws on unknown names. */
export function resolveNetwork(network) {
  const wanted = String(network || 'local').toLowerCase().trim();
  if (wanted === 'local') return null;
  for (const [name, conf] of Object.entries(REMOTES)) {
    if (name === wanted || conf.aliases.includes(wanted)) return { name, ...conf };
  }
  throw new Error(`Unknown network "${network}". Available: ${NETWORK_NAMES.join(', ')}`);
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export async function executeRemoteTool(toolName, args, remote) {
  if (!/^[a-z0-9_]+$/.test(toolName)) {
    throw new Error(`Invalid tool name for remote execution: ${toolName}`);
  }
  const b64Args = Buffer.from(JSON.stringify(args)).toString('base64');
  const runner = `${remote.path.replace(/\/$/, '')}/src/tool_runner.mjs`;
  const remoteCmd = `node ${shellQuote(runner)} ${toolName} ${b64Args}`;

  try {
    const { stdout, stderr } = await execFileAsync(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', remote.ssh, remoteCmd],
      { maxBuffer: 10 * 1024 * 1024 }
    );

    const trimmed = stdout.trim();
    if (!trimmed) {
      if (stderr) throw new Error(stderr);
      throw new Error(`Empty response from remote "${remote.name}".`);
    }

    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Remote execution failed (${remote.name}): ${err.message}`);
  }
}
