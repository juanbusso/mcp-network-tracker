import readline from 'node:readline';
import { NETWORK_NAMES, executeRemoteTool, resolveNetwork } from './remote_exec.mjs';
import { executeTool } from './tool_runner.mjs';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function sendResponse(id, result, error = null) {
  const response = {
    jsonrpc: '2.0',
    id
  };
  if (error) {
    response.error = error;
  } else {
    response.result = result;
  }
  process.stdout.write(JSON.stringify(response) + '\n');
}

const DEFAULT_NETWORK = (process.env.DEFAULT_NETWORK || 'local').toLowerCase();
// Validate at startup so a typo in DEFAULT_NETWORK fails loudly.
resolveNetwork(DEFAULT_NETWORK);

const NETWORK_PROP = {
  type: 'string',
  enum: NETWORK_NAMES,
  description: `Network to query: "local" (this machine's LAN)${
    NETWORK_NAMES.length > 1 ? ` or a remote configured in NETWORK_TRACKER_REMOTES_JSON (${NETWORK_NAMES.slice(1).join(', ')})` : ''
  }. Default: "${DEFAULT_NETWORK}".`
};

const TOOLS = [
  {
    name: 'network_get_status',
    description:
      'Gets the live network status: people present/absent and the list of connected and disconnected devices.',
    inputSchema: {
      type: 'object',
      properties: {
        network: NETWORK_PROP,
        filter: {
          type: 'string',
          enum: ['all', 'online', 'offline'],
          description: 'Device filter: "online" (default), "offline", or "all".'
        }
      }
    }
  },
  {
    name: 'network_scan_now',
    description: 'Forces an immediate network scan (ping sweep + ARP) and returns the detected changes.',
    inputSchema: {
      type: 'object',
      properties: {
        network: NETWORK_PROP
      }
    }
  },
  {
    name: 'network_list_people',
    description:
      'Lists all registered people, their assigned devices, whether they are currently present on the network and when they were last seen.',
    inputSchema: {
      type: 'object',
      properties: {
        network: NETWORK_PROP
      }
    }
  },
  {
    name: 'network_add_person',
    description: 'Registers a new person so devices can be assigned to them and their presence tracked.',
    inputSchema: {
      type: 'object',
      properties: {
        network: NETWORK_PROP,
        name: { type: 'string', description: 'Person name (e.g. "Alice", "Bob")' },
        notes: { type: 'string', description: 'Optional notes (e.g. "Roommate")' }
      },
      required: ['name']
    }
  },
  {
    name: 'network_assign_device',
    description: 'Assigns a device (by MAC address) to a person, so the person is marked present while the device is connected.',
    inputSchema: {
      type: 'object',
      properties: {
        network: NETWORK_PROP,
        mac: { type: 'string', description: 'Device MAC address (e.g. "aa:bb:cc:dd:ee:ff")' },
        person: { type: 'string', description: 'Person name or ID' }
      },
      required: ['mac', 'person']
    }
  },
  {
    name: 'network_rename_device',
    description: 'Gives a device a friendly name/alias (e.g. "Alice\'s phone", "Living Room TV").',
    inputSchema: {
      type: 'object',
      properties: {
        network: NETWORK_PROP,
        mac: { type: 'string', description: 'Device MAC address' },
        custom_name: { type: 'string', description: 'New friendly name for the device' }
      },
      required: ['mac', 'custom_name']
    }
  },
  {
    name: 'network_get_device_history',
    description: 'Gets the chronological history of connections, disconnections and IP changes for one device or the whole network.',
    inputSchema: {
      type: 'object',
      properties: {
        network: NETWORK_PROP,
        mac: { type: 'string', description: 'Optional: filter by MAC address' },
        limit: { type: 'number', description: 'Optional: maximum number of events (default 50)' }
      }
    }
  },
  {
    name: 'network_get_person_history',
    description: 'Gets the presence history of a person (when their devices connected or disconnected).',
    inputSchema: {
      type: 'object',
      properties: {
        network: NETWORK_PROP,
        person: { type: 'string', description: 'Person name or ID' },
        limit: { type: 'number', description: 'Optional: maximum number of events (default 50)' }
      },
      required: ['person']
    }
  }
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

async function handleToolCall(name, args = {}) {
  if (!TOOL_NAMES.has(name)) throw new Error(`Unknown tool: ${name}`);
  const remote = resolveNetwork(args.network || DEFAULT_NETWORK);
  if (remote) {
    return await executeRemoteTool(name, args, remote);
  }
  return await executeTool(name, args);
}

rl.on('line', async (line) => {
  if (!line.trim()) return;

  try {
    const request = JSON.parse(line);
    const { id, method, params } = request;

    if (method === 'initialize') {
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'network-tracker-mcp',
          version: '1.0.0'
        }
      });
    } else if (method === 'notifications/initialized') {
      // No response needed for notifications
    } else if (method === 'ping') {
      sendResponse(id, {});
    } else if (method === 'tools/list') {
      sendResponse(id, {
        tools: TOOLS
      });
    } else if (method === 'tools/call') {
      try {
        const resultData = await handleToolCall(params.name, params.arguments || {});
        sendResponse(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(resultData, null, 2)
            }
          ]
        });
      } catch (callErr) {
        sendResponse(id, {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error running ${params.name}: ${callErr.message}`
            }
          ]
        });
      }
    } else {
      sendResponse(id, null, {
        code: -32601,
        message: `Method not found: ${method}`
      });
    }
  } catch (err) {
    console.error('Error processing JSON-RPC:', err);
  }
});

