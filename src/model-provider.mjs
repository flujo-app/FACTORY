// One description of a self-hosted model endpoint, mapped to each worker program's own
// configuration. vLLM serves the same model through the OpenAI Responses API (Codex), the
// Anthropic Messages API (Claude Code) and Chat Completions.

/** Wire APIs an endpoint can offer. */
export const MODEL_PROVIDER_APIS = ['responses', 'chat', 'anthropic'];
/**
 * The wire APIs each worker program can use, best first. Codex and Claude Code know one each;
 * FLUJO has an adapter for all three and prefers the Responses API.
 */
export const WORKER_PROGRAM_APIS = Object.freeze({ codex: Object.freeze(['responses']), claude: Object.freeze(['anthropic']), flujo: Object.freeze(['responses', 'chat', 'anthropic']) });
// Variables the launchers set for the worker process itself; a provider key must not replace them.
const RESERVED_ENVIRONMENT = new Set(['PATH', 'HOME', 'CODEX_HOME', 'GH_TOKEN', 'GIT_TERMINAL_PROMPT',
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']);
const credentialFreeHttps = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
};

/**
 * A self-hosted, OpenAI-compatible model endpoint. `baseUrls` are OpenAI-style base URLs
 * (usually ending in `/v1`); several URLs are separate servers of the same model. `apis`
 * lists the wire APIs the server offers (default `['responses']`).
 */
export function validateModelProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) throw new TypeError('modelProvider must be an object.');
  if (!/^[a-z][a-z0-9_-]{1,40}$/.test(provider.id ?? '')) throw new TypeError('modelProvider.id must be a short lowercase name.');
  if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(provider.envKey ?? '') || RESERVED_ENVIRONMENT.has(provider.envKey)) throw new TypeError('modelProvider.envKey must name a dedicated environment variable.');
  if (!Array.isArray(provider.baseUrls) || !provider.baseUrls.length || provider.baseUrls.length > 64 || !provider.baseUrls.every(credentialFreeHttps))
    throw new TypeError('modelProvider.baseUrls must list https URLs without credentials, query or fragment.');
  for (const name of ['name', 'model']) if (provider[name] !== undefined && (typeof provider[name] !== 'string' || !provider[name].trim() || provider[name].length > 200)) throw new TypeError(`modelProvider.${name} must be short text.`);
  if (provider.apis !== undefined && (!Array.isArray(provider.apis) || !provider.apis.length || !provider.apis.every(api => MODEL_PROVIDER_APIS.includes(api))))
    throw new TypeError(`modelProvider.apis must list ${MODEL_PROVIDER_APIS.join(', ')}.`);
  for (const name of ['contextWindow', 'autoCompactTokenLimit', 'toolOutputTokenLimit']) {
    if (provider[name] !== undefined && (!Number.isSafeInteger(provider[name]) || provider[name] < 1000)) throw new TypeError(`modelProvider.${name} must be a token count of at least 1000.`);
  }
  if (provider.contextWindow && provider.autoCompactTokenLimit && provider.autoCompactTokenLimit >= provider.contextWindow) throw new TypeError('modelProvider.autoCompactTokenLimit must be below contextWindow.');
  for (const name of ['requestMaxRetries', 'streamMaxRetries']) {
    if (provider[name] !== undefined && (!Number.isSafeInteger(provider[name]) || provider[name] < 0 || provider[name] > 100)) throw new TypeError(`modelProvider.${name} must be between 0 and 100.`);
  }
  for (const name of ['streamIdleTimeoutMs', 'requestTimeoutMs']) {
    if (provider[name] !== undefined && (!Number.isSafeInteger(provider[name]) || provider[name] < 1000)) throw new TypeError(`modelProvider.${name} must be at least 1000.`);
  }
  return provider;
}

/** The wire APIs a provider offers (the default keeps 0.4.0 descriptions valid for Codex). */
export const providerApis = provider => provider.apis ?? ['responses'];

/** The API a worker program would use on this provider, or undefined when they share none. */
export function programApi(provider, program) {
  const apis = providerApis(provider);
  return WORKER_PROGRAM_APIS[program]?.find(api => apis.includes(api));
}

/** Which worker programs can use this provider. */
export function providerPrograms(provider) {
  return Object.keys(WORKER_PROGRAM_APIS).filter(program => programApi(provider, program));
}

const apiNames = program => WORKER_PROGRAM_APIS[program].join(' or ');

function requireApi(provider, program) {
  validateModelProvider(provider);
  if (!programApi(provider, program)) throw new TypeError(`${program} needs a provider that offers the ${apiNames(program)} API.`);
}

/** A cloud plan's refusal, in the words its operator knows. */
export function requireFleetApi(provider, program) {
  if (!programApi(provider, program)) throw new TypeError(`Cloud lite workers need a provider that offers the ${apiNames(program)} API.`);
}

/** Spread workers over the endpoints so each keeps its prompt cache on one server. */
export const providerBaseUrl = (provider, index = 0) => provider.baseUrls[Math.abs(index) % provider.baseUrls.length];

// Codex: settings as TOML-ready entries, rendered either as config.toml or as --config overrides.
function codexEntries(provider, { index = 0, model, reasoningEffort } = {}) {
  requireApi(provider, 'codex');
  const top = [
    ['model', provider.model ?? model],
    ['model_provider', provider.id],
    ...(reasoningEffort ? [['model_reasoning_effort', reasoningEffort]] : []),
    ...(provider.contextWindow ? [['model_context_window', provider.contextWindow]] : []),
    ...(provider.autoCompactTokenLimit ? [['model_auto_compact_token_limit', provider.autoCompactTokenLimit]] : []),
    ...(provider.toolOutputTokenLimit ? [['tool_output_token_limit', provider.toolOutputTokenLimit]] : []),
    ['web_search', 'disabled'],
    ['check_for_update_on_startup', false],
    ['cli_auth_credentials_store', 'ephemeral'],
  ];
  if (typeof top[0][1] !== 'string' || !top[0][1]) throw new TypeError('Select the served model name.');
  const tables = [
    ['features', [['multi_agent', false], ['goals', false], ['apps', false], ['plugins', false], ['memories', false]]],
    ['skills', [['include_instructions', false]]],
    // Agents' shell commands get only the basic variables, never the provider key.
    ['shell_environment_policy', [['inherit', 'core']]],
    [`model_providers.${provider.id}`, [
      ['name', provider.name ?? provider.id],
      ['base_url', providerBaseUrl(provider, index)],
      ['env_key', provider.envKey],
      ['wire_api', 'responses'],
      ['request_max_retries', provider.requestMaxRetries ?? 8],
      ['stream_max_retries', provider.streamMaxRetries ?? 10],
      ['stream_idle_timeout_ms', provider.streamIdleTimeoutMs ?? 900000],
    ]],
  ];
  return { top, tables };
}
const tomlValue = value => typeof value === 'string' ? JSON.stringify(value) : String(value);

/** Codex `config.toml` for a self-hosted provider (Responses API). The key is never written. */
export function codexProviderConfig(provider, options = {}) {
  const { top, tables } = codexEntries(provider, options);
  return [...top.map(([key, value]) => `${key} = ${tomlValue(value)}`), '',
    ...tables.flatMap(([table, entries]) => [`[${table}]`, ...entries.map(([key, value]) => `${key} = ${tomlValue(value)}`), '']),
  ].join('\n');
}

/** The same Codex settings as `--config key=value` overrides (for an existing CODEX_HOME). */
export function codexProviderOverrides(provider, options = {}) {
  const { top, tables } = codexEntries(provider, options);
  return [...top.map(([key, value]) => `${key}=${tomlValue(value)}`),
    ...tables.flatMap(([table, entries]) => entries.map(([key, value]) => `${table}.${key}=${tomlValue(value)}`))];
}

// A caller that itself runs inside a Claude session (a desktop or SDK session) passes that
// session's variables on; a Claude Code child then offers the session's own login to the
// endpoint (HTTP 401) instead of the endpoint key. By name pattern, not by a list: such sessions
// add variables with every version.
const CLAUDE_SESSION_VARIABLE = /^(CLAUDE|ANTHROPIC_)|OAUTH/i;

/**
 * Claude Code environment for a self-hosted provider (Anthropic Messages API at the server
 * root). Every model alias maps to the served model; nonessential traffic is off. Keys whose
 * value is null must be removed from the inherited environment: every Claude session variable
 * of `inherited` (default: this process) is.
 */
export function claudeProviderEnvironment(provider, { index = 0, key, model, inherited = process.env } = {}) {
  requireApi(provider, 'claude');
  if (typeof key !== 'string' || key.length < 8) throw new TypeError('A model provider needs its API key.');
  const served = provider.model ?? model;
  if (typeof served !== 'string' || !served) throw new TypeError('Select the served model name.');
  return {
    ...Object.fromEntries(Object.keys(inherited ?? {}).filter(name => CLAUDE_SESSION_VARIABLE.test(name)).map(name => [name, null])),
    ANTHROPIC_BASE_URL: providerBaseUrl(provider, index).replace(/\/+$/, '').replace(/\/v1$/, ''),
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: null,
    CLAUDE_CODE_OAUTH_TOKEN: null,
    ANTHROPIC_MODEL: served,
    ANTHROPIC_DEFAULT_OPUS_MODEL: served,
    ANTHROPIC_DEFAULT_SONNET_MODEL: served,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: served,
    ANTHROPIC_SMALL_FAST_MODEL: served,
    CLAUDE_CODE_SUBAGENT_MODEL: served,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    // A shared GPU may queue a request for a while.
    API_TIMEOUT_MS: String(provider.requestTimeoutMs ?? 1800000),
    // The per-turn token reminder is an extra system message; chat templates that allow one
    // system message move it to the front, which defeats the server's prompt cache.
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
    ...(provider.contextWindow ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(provider.contextWindow) } : {}),
    ...(provider.autoCompactTokenLimit ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(provider.autoCompactTokenLimit) } : {}),
  };
}

// FLUJO keeps a model as a stored record, so its settings differ by adapter rather than by variable.
const FLUJO_ADAPTERS = Object.freeze({ responses: 'openai-responses', chat: 'openai', anthropic: 'anthropic' });
// FLUJO moves the system message behind the conversation for OpenAI's own prompt cache. Open models'
// chat templates refuse that, so only OpenAI's endpoint may carry the openai name.
const flujoProviderName = (api, base) => api === 'anthropic' ? 'anthropic' : new URL(base).hostname === 'api.openai.com' ? 'openai' : 'litellm';

/**
 * FLUJO model record for a self-hosted provider, for `POST /api/model`. FLUJO stores the key in its
 * own encrypted settings, so it never enters the process environment that agent commands inherit.
 */
export function flujoProviderModel(provider, { index = 0, key, model } = {}) {
  requireApi(provider, 'flujo');
  if (typeof key !== 'string' || key.length < 8) throw new TypeError('A model provider needs its API key.');
  const served = provider.model ?? model;
  if (typeof served !== 'string' || !served) throw new TypeError('Select the served model name.');
  const api = programApi(provider, 'flujo');
  const base = providerBaseUrl(provider, index);
  return { id: `factory-${provider.id}`, name: served, displayName: provider.name ?? provider.id, provider: flujoProviderName(api, base), adapter: FLUJO_ADAPTERS[api],
    // The Anthropic client adds /v1 itself.
    baseUrl: api === 'anthropic' ? base.replace(/\/+$/, '').replace(/\/v1$/, '') : base,
    ApiKey: key, supportsTools: true,
    ...(provider.contextWindow ? { contextWindow: provider.contextWindow } : {}),
    ...(provider.autoCompactTokenLimit ? { compactionThreshold: provider.autoCompactTokenLimit } : {}) };
}

/** Apply a mapping's environment to an inherited one (null removes a variable). */
export function applyProviderEnvironment(base, overlay) {
  const env = { ...base };
  for (const [name, value] of Object.entries(overlay)) { if (value === null) delete env[name]; else env[name] = value; }
  return env;
}
