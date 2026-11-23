import { LOCAL_MODEL_HOSTS } from '../model-provider.mjs';

/**
 * Extra MCP servers that every agent of a fleet gets next to FACTORY's own job board (`plan.mcpServers`).
 * A server runs inside each worker container (`command`, `args`, `env`) or is reached over the network
 * (`url`, `headers`). A value that is a key is written `{ secret: 'NAME' }`; the key itself goes to
 * `deploy(plan, { mcpSecrets: { NAME: '...' } })`, so the plan, the fleet journal and traces never hold it.
 */
export const MCP_SERVER_LIMIT = 16;
const SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const SETTINGS = { command: new Set(['command', 'args', 'env', 'required']), url: new Set(['url', 'headers', 'required']) };
const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\0\r\n]/.test(value);

function validUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:' && LOCAL_MODEL_HOSTS.includes(url.hostname)) && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

/** Checks `plan.mcpServers` and returns the names of the keys it refers to. */
export function validateMcpServers(servers) {
  if (!plainObject(servers)) throw new TypeError('mcpServers must be an object of named servers.');
  const names = Object.keys(servers);
  if (!names.length || names.length > MCP_SERVER_LIMIT) throw new TypeError(`mcpServers must name 1 to ${MCP_SERVER_LIMIT} servers.`);
  const secrets = new Set();
  const value = (where, entry) => {
    if (text(entry)) return;
    if (plainObject(entry) && Object.keys(entry).length === 1 && SECRET_NAME.test(entry.secret ?? '')) { secrets.add(entry.secret); return; }
    throw new TypeError(`${where} must be one line of text, or { secret: 'NAME' } for a key given to deploy as mcpSecrets.NAME.`);
  };
  for (const name of names) {
    if (!SERVER_NAME.test(name)) throw new TypeError(`mcpServers: "${name}" is not a valid server name (lowercase letters, digits, - and _, up to 32).`);
    if (name === 'factory') throw new TypeError('mcpServers: "factory" is the job board, which every agent already has.');
    const server = servers[name], where = `mcpServers.${name}`;
    if (!plainObject(server)) throw new TypeError(`${where} must be an object.`);
    if ((server.command === undefined) === (server.url === undefined)) throw new TypeError(`${where} needs either a command (a server in each container) or a url (a server reached over the network).`);
    const kind = server.url === undefined ? 'command' : 'url';
    const unknown = Object.keys(server).filter(key => !SETTINGS[kind].has(key));
    if (unknown.length) throw new TypeError(`${where} has settings it cannot use: ${unknown.join(', ')}.`);
    if (server.required !== undefined && typeof server.required !== 'boolean') throw new TypeError(`${where}.required must be true or false.`);
    if (kind === 'command') {
      if (!text(server.command)) throw new TypeError(`${where}.command must be one line of text.`);
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.length > 64 || !server.args.every(arg => typeof arg === 'string' && arg.length <= 8192 && !/[\0\r\n]/.test(arg)))) {
        throw new TypeError(`${where}.args must be a list of up to 64 one-line texts.`);
      }
      if (server.env !== undefined) {
        if (!plainObject(server.env)) throw new TypeError(`${where}.env must be an object.`);
        for (const [key, entry] of Object.entries(server.env)) {
          if (!ENV_NAME.test(key)) throw new TypeError(`${where}.env: "${key}" is not a valid environment variable name.`);
          value(`${where}.env.${key}`, entry);
        }
      }
    } else {
      if (!validUrl(server.url)) throw new TypeError(`${where}.url must be an https address without user name, password or fragment; plain http only for this computer (${LOCAL_MODEL_HOSTS.join(', ')}).`);
      if (server.headers !== undefined) {
        if (!plainObject(server.headers)) throw new TypeError(`${where}.headers must be an object.`);
        for (const [key, entry] of Object.entries(server.headers)) {
          if (!HEADER_NAME.test(key)) throw new TypeError(`${where}.headers: "${key}" is not a valid header name.`);
          value(`${where}.headers.${key}`, entry);
        }
      }
    }
  }
  return [...secrets].sort();
}

/** Checks the keys given to deploy against the ones the plan refers to: every one needed, none extra. */
export function validateMcpSecrets(servers, secrets) {
  const wanted = servers === undefined ? [] : validateMcpServers(servers);
  if (secrets === undefined && !wanted.length) return {};
  if (!plainObject(secrets)) throw new TypeError(`The plan's MCP servers need these keys in mcpSecrets: ${wanted.join(', ')}.`);
  const given = Object.keys(secrets).sort();
  const missing = wanted.filter(name => !given.includes(name)), extra = given.filter(name => !wanted.includes(name));
  if (missing.length) throw new TypeError(`mcpSecrets is missing ${missing.join(', ')}, which the plan's MCP servers refer to.`);
  if (extra.length) throw new TypeError(`mcpSecrets has ${extra.join(', ')}, which no MCP server of the plan refers to.`);
  for (const [name, value] of Object.entries(secrets)) {
    if (typeof value !== 'string' || value.length < 8 || value.length > 8192 || /[\0\r\n]/.test(value)) throw new TypeError(`mcpSecrets.${name} must be one line of at least 8 characters.`);
  }
  return secrets;
}

/** The hosts of plain-http server addresses: all of them are names for this computer. */
export const mcpPlainHttpHosts = servers => Object.values(servers ?? {}).filter(server => server.url && new URL(server.url).protocol === 'http:').map(server => new URL(server.url).hostname);

/**
 * The servers as Codex's per-session settings (`mcp_servers`), with the keys filled in. The Claude
 * Code driver reads the same entries. They live only in memory and in private files, never in traces.
 */
export function resolveMcpServers(servers, secrets = {}) {
  const fill = entries => Object.fromEntries(Object.entries(entries ?? {}).map(([key, entry]) => [key, typeof entry === 'string' ? entry : secrets[entry.secret]]));
  return Object.fromEntries(Object.entries(servers ?? {}).map(([name, server]) => [name, server.url === undefined
    ? { command: server.command, args: server.args ?? [], env: fill(server.env), required: server.required === true }
    : { url: server.url, ...(server.headers ? { http_headers: fill(server.headers) } : {}), required: server.required === true }]));
}
