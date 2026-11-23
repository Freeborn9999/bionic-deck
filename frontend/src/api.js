// Shared API client for the Bionic Deck backend (FastAPI on :8000).
const API =
  (typeof window !== 'undefined' && window.__BIONIC_API__) ||
  'http://localhost:8000';

export async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail =
      (body && (body.detail || body.message)) ||
      res.statusText ||
      `HTTP ${res.status}`;
    const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export { API };
