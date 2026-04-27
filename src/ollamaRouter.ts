const DEFAULT_OLLAMA_BASE_URL = 'http://192.168.50.59';
const DEFAULT_OLLAMA_PORT = '11434';
const DEFAULT_OLLAMA_GPU1_PORT = '11435';

const GPU1_MODELS = new Set([
  'gemma4:e4b',
  'petedio-coder',
  'petedio-claude-code',
  'qwen3:14b',
]);

function normalizeModelName(model: string): string {
  return model.trim().toLowerCase().replace(/:latest$/, '');
}

function getBaseUrl(): string {
  const raw = process.env.OLLAMA_BASE_URL
    ?? process.env.OLLAMA_URL
    ?? `${DEFAULT_OLLAMA_BASE_URL}:${DEFAULT_OLLAMA_PORT}`;

  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return raw.replace(/\/+$/, '').replace(/:\d+$/, '');
  }
}

export function resolveOllamaUrl(model: string): string {
  if (GPU1_MODELS.has(normalizeModelName(model))) {
    return process.env.OLLAMA_URL_GPU1 ?? `${getBaseUrl()}:${DEFAULT_OLLAMA_GPU1_PORT}`;
  }

  return process.env.OLLAMA_URL ?? `${getBaseUrl()}:${DEFAULT_OLLAMA_PORT}`;
}
