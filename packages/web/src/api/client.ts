async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      /* keep statusText */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const get = <T>(path: string): Promise<T> => request<T>('GET', path);
export const put = <T>(path: string, body: unknown): Promise<T> => request<T>('PUT', path, body);
export const post = <T>(path: string, body: unknown): Promise<T> => request<T>('POST', path, body);
