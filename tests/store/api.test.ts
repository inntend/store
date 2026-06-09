import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { api, setApiDelay } from '../../src/store/api';

// ─── fetch mock helpers ───────────────────────────────────────────────────────

function mockFetch(
  jsonBody: unknown,
  overrides: { ok?: boolean; status?: number; statusText?: string } = {},
) {
  const { ok = true, status = 200, statusText = 'OK' } = overrides;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status,
      statusText,
      json: () => Promise.resolve(jsonBody),
      body: null,
    } as unknown as Response),
  );
}

function lastFetchCall() {
  return (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
    URL,
    RequestInit,
  ];
}

// ─── api ──────────────────────────────────────────────────────────────────────

describe('api', () => {
  beforeEach(() => {
    setApiDelay(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ─── HTTP method & URL ──────────────────────────────────────────────────────

  it('defaults to GET', async () => {
    mockFetch({});
    await api('https://example.com/items', {});
    const [, init] = lastFetchCall();
    expect(init.method).toBe('GET');
  });

  it('passes the method through', async () => {
    mockFetch({});
    await api('https://example.com/items', { method: 'POST' });
    const [, init] = lastFetchCall();
    expect(init.method).toBe('POST');
  });

  it('builds URL with query parameters', async () => {
    mockFetch({});
    const params = new URLSearchParams({ page: '2' });
    await api('https://example.com/items', { parameters: params });
    const [url] = lastFetchCall();
    expect(url.toString()).toBe('https://example.com/items?page=2');
  });

  it('appends cursor to query parameters', async () => {
    mockFetch({});
    await api('https://example.com/items', { cursor: 'abc123' });
    const [url] = lastFetchCall();
    expect(new URL(url.toString()).searchParams.get('cursor')).toBe('abc123');
  });

  it('cursor combined with other parameters', async () => {
    mockFetch({});
    const params = new URLSearchParams({ limit: '10' });
    await api('https://example.com/items', {
      parameters: params,
      cursor: 'tok',
    });
    const [url] = lastFetchCall();
    const search = new URL(url.toString()).searchParams;
    expect(search.get('limit')).toBe('10');
    expect(search.get('cursor')).toBe('tok');
  });

  it('accepts a URL object as input', async () => {
    mockFetch({});
    await api(new URL('https://example.com/path'), {});
    const [url] = lastFetchCall();
    expect(url.toString()).toBe('https://example.com/path');
  });

  // ─── Headers ────────────────────────────────────────────────────────────────

  it('always sets Content-Type: application/json', async () => {
    mockFetch({});
    await api('https://example.com', {});
    const [, init] = lastFetchCall();
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
  });

  it('includes Authorization header when token is provided', async () => {
    mockFetch({});
    await api('https://example.com', { token: 'my-token' });
    const [, init] = lastFetchCall();
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer my-token',
    );
  });

  it('omits Authorization header when token is undefined', async () => {
    mockFetch({});
    await api('https://example.com', {});
    const [, init] = lastFetchCall();
    expect(
      (init.headers as Record<string, string>)['Authorization'],
    ).toBeUndefined();
  });

  it('omits Authorization header when token is null', async () => {
    mockFetch({});
    await api('https://example.com', { token: null });
    const [, init] = lastFetchCall();
    expect(
      (init.headers as Record<string, string>)['Authorization'],
    ).toBeUndefined();
  });

  // ─── Request body ───────────────────────────────────────────────────────────

  it('JSON-serialises the body when provided', async () => {
    mockFetch({});
    await api('https://example.com', { method: 'POST', body: { foo: 'bar' } });
    const [, init] = lastFetchCall();
    expect(init.body).toBe('{"foo":"bar"}');
  });

  it('omits body from fetch init when body is not provided', async () => {
    mockFetch({});
    await api('https://example.com', {});
    const [, init] = lastFetchCall();
    expect(init.body).toBeUndefined();
  });

  // ─── Response handling ──────────────────────────────────────────────────────

  it('returns raw json when no schema is given', async () => {
    mockFetch({ items: [1, 2] });
    const result = await api('https://example.com', {});
    expect(result).toEqual({ items: [1, 2] });
  });

  it('parses and returns data when schema is given', async () => {
    const schema = z.object({ id: z.string(), name: z.string() });
    mockFetch({ data: { id: '1', name: 'Alice' } });
    const result = await api('https://example.com', { schema });
    expect(result).toEqual({ id: '1', name: 'Alice' });
  });

  it('throws ZodError when schema validation fails', async () => {
    const schema = z.object({ id: z.string() });
    mockFetch({ data: { id: 42 } }); // id should be string
    await expect(api('https://example.com', { schema })).rejects.toThrow();
  });

  it('throws when response is not ok', async () => {
    mockFetch(null, { ok: false, status: 404, statusText: 'Not Found' });
    await expect(api('https://example.com', {})).rejects.toThrow(
      '404 Not Found',
    );
  });

  it('throws with status and statusText for 500', async () => {
    mockFetch(null, {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });
    await expect(api('https://example.com', {})).rejects.toThrow(
      '500 Internal Server Error',
    );
  });

  // ─── setApiDelay ─────────────────────────────────────────────────────────────

  it('delays when API_DELAY_MS is set', async () => {
    vi.useFakeTimers();
    setApiDelay(100);
    mockFetch({});

    let resolved = false;
    const promise = api('https://example.com', {}).then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await promise;
    expect(resolved).toBe(true);

    vi.useRealTimers();
  });

  it('does not delay when API_DELAY_MS is undefined', async () => {
    setApiDelay(undefined);
    mockFetch({});
    await expect(api('https://example.com', {})).resolves.toBeDefined();
  });
});
