/**
 * @file Minimal OpenAI-compatible AI client + local (0600) provider settings.
 *
 * No SDK dependency: the app talks to an OpenAI-compatible /chat/completions endpoint
 * (DeepSeek, OpenAI, Ollama, ...). The API key lives in DATA_DIR/ai.json, never in the repo.
 */
const fs = require('fs');
const path = require('path');
const env = require('../env');

const FILE = path.join(env.DATA_DIR, 'ai.json');
const DEFAULTS = {
  enabled: false,
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
  timeoutMs: 15000,
  assistantEnabled: true,
};

function envOverrides() {
  const out = {};
  if (process.env.AI_ENABLED != null) out.enabled = /^(1|true|yes|on)$/i.test(String(process.env.AI_ENABLED));
  if (process.env.AI_BASE_URL) out.baseUrl = process.env.AI_BASE_URL;
  if (process.env.AI_MODEL) out.model = process.env.AI_MODEL;
  if (process.env.AI_API_KEY) out.apiKey = process.env.AI_API_KEY;
  if (process.env.AI_TIMEOUT_MS) out.timeoutMs = Number(process.env.AI_TIMEOUT_MS);
  return out;
}

function load() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {}
  return { ...DEFAULTS, ...file, ...envOverrides() };
}

function publicConfig(cfg = load()) {
  return {
    enabled: !!cfg.enabled,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    hasApiKey: !!cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
    assistantEnabled: cfg.assistantEnabled !== false,
    file: FILE,
  };
}

function save(patch = {}) {
  const current = load();
  const next = { ...current, ...patch };
  // never persist an empty/masked key over an existing one
  if (patch.apiKey == null || patch.apiKey === '' || /^\*+$/.test(String(patch.apiKey))) next.apiKey = current.apiKey;
  const data = {
    enabled: !!next.enabled,
    baseUrl: String(next.baseUrl || DEFAULTS.baseUrl),
    model: String(next.model || DEFAULTS.model),
    apiKey: String(next.apiKey || ''),
    timeoutMs: Math.min(120000, Math.max(1000, Number(next.timeoutMs) || DEFAULTS.timeoutMs)),
    assistantEnabled: next.assistantEnabled !== false,
  };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch (e) {}
  return publicConfig(data);
}

function configured(cfg = load()) {
  return !!(cfg.enabled && cfg.apiKey && cfg.baseUrl && cfg.model);
}

function completionsUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('AI baseUrl 为空');
  return /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
}

async function chat({ messages, json = false, cfg = load(), timeoutMs = null, temperature = null, fetchImpl = global.fetch } = {}) {
  if (!configured(cfg)) throw new Error('AI 未启用或缺少 API Key');
  const controller = new AbortController();
  const timeout = Math.min(120000, Math.max(1000, Number(timeoutMs || cfg.timeoutMs) || 15000));
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetchImpl(completionsUrl(cfg.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: temperature == null
          ? (json ? 0 : 0.3)
          : Math.min(2, Math.max(0, Number(temperature) || 0)),
        messages,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`AI HTTP ${res.status}: ${text.slice(0, 300)}`);
    let payload;
    try { payload = JSON.parse(text); } catch (e) { throw new Error('AI 返回不是 JSON'); }
    const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
      ? payload.choices[0].message.content
      : '';
    if (!content) throw new Error('AI 返回内容为空');
    return { content: String(content), usage: payload.usage || null, raw: payload };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`AI 超时（${timeout}ms）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch (e) {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch (e) {}
  }
  throw new Error('AI 没有返回合法 JSON');
}

async function chatJson(opts = {}) {
  const out = await chat({ ...opts, json: true });
  return { ...out, data: extractJson(out.content) };
}

module.exports = {
  FILE,
  DEFAULTS,
  load,
  save,
  publicConfig,
  configured,
  chat,
  chatJson,
  extractJson,
  completionsUrl,
};
