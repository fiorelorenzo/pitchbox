import { getSettings } from './storage.js';

export type ApiResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

type DraftSummary = {
  id: number;
  kind: string;
  state: string;
  body: string;
  targetUser: string | null;
};

async function authHeaders(): Promise<{ backendUrl: string; headers: HeadersInit } | null> {
  const { backendUrl, token } = await getSettings();
  if (!backendUrl || !token) return null;
  return {
    backendUrl,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
  };
}

async function postJson<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  const auth = await authHeaders();
  if (!auth) return { ok: false, status: 0, error: 'not configured' };
  try {
    const res = await fetch(`${auth.backendUrl}${path}`, {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, status: res.status, error: await res.text() };
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

async function getJson<T>(path: string): Promise<ApiResult<T>> {
  const auth = await authHeaders();
  if (!auth) return { ok: false, status: 0, error: 'not configured' };
  try {
    const res = await fetch(`${auth.backendUrl}${path}`, { headers: auth.headers });
    if (!res.ok) return { ok: false, status: res.status, error: await res.text() };
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

export const api = {
  handshake: () => postJson<{ ok: true; version: string }>('/api/extension/handshake', {}),
  getDraft: (draftId: number) => getJson<DraftSummary>(`/api/extension/draft/${draftId}`),
  armed: (draftId: number) =>
    postJson<{ ok: true }>(`/api/extension/draft/${draftId}/armed`, {
      composedAt: new Date().toISOString(),
    }),
  sent: (
    draftId: number,
    sentContent?: string,
    commentLookup?: { postId: string; accountHandle: string; postedAt: string },
  ) =>
    postJson<{ ok: true }>(`/api/extension/draft/${draftId}/sent`, {
      sentContent,
      sentAt: new Date().toISOString(),
      commentLookup,
    }),
  dmSync: (platform: string, items: unknown[], comments: unknown[] = []) =>
    postJson<{
      ok: true;
      inserted: number;
      replied: number;
      commentsInserted?: number;
      commentsReplied?: number;
    }>('/api/extension/dm-sync', { platform, items, comments }),
  dmSyncStatus: () => getJson<{ lastSyncAt: string | null }>('/api/extension/dm-sync/status'),
};
