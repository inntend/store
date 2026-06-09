import { type ZodType, z } from 'zod';

let API_DELAY_MS: number | undefined = undefined;
export function setApiDelay(ms?: number) {
  API_DELAY_MS = ms;
}

export type APIParameters<T> = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  parameters?: URLSearchParams;
  cursor?: string;
  schema?: ZodType<T>;
  token?: string | null;
  body?: any;
};

export async function api<T>(
  url: URL | string,
  {
    method = 'GET',
    parameters = new URLSearchParams(),
    cursor,
    schema,
    token,
    body,
  }: APIParameters<T>,
): Promise<T | undefined> {
  // Simulate network delay if set
  if (API_DELAY_MS) {
    console.log(`Simulate delay (${API_DELAY_MS}ms): ${url}`);
    await new Promise((resolve) => setTimeout(resolve, API_DELAY_MS));
  }

  // Construct the full URL with query parameters.
  // Pass location.href as base so relative paths (e.g. '/api/sync') work in
  // browser and worker contexts. Absolute URLs ignore the base entirely.
  if (cursor) parameters.set('cursor', cursor);
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  url = new URL(url instanceof URL ? url.href : url, base);
  url.search = parameters.toString();

  const response = await fetch(url, {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: 'include',
    ...(body ? { body: JSON.stringify(body) } : {}),
  } as RequestInit);
  if (!response.ok) {
    console.error(
      `API Error: ${method} ${url}`,
      response.status,
      response.statusText,
      response.body,
    );
    throw new Error(`${response.status} ${response.statusText}`);
  }

  // Receive and parse the response
  let result: T | undefined;
  if (schema) {
    const parsed = z.object({ data: schema }).parse(await response.json());
    result = parsed.data;
  } else {
    result = await response.json();
  }

  return result;
}
