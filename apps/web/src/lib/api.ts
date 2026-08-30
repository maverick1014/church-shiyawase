// Default to same-origin: the API now lives in Next.js route handlers under
// /api (which run on the Cloudflare Workers runtime via OpenNext). Set
// NEXT_PUBLIC_API_URL only if you want to point at a standalone API host
// (e.g. the legacy NestJS server on :4000).
const BASE = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? '';

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  // Let the browser set the multipart boundary for FormData bodies.
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const res = await fetch(`${BASE}/api${path}`, {
    ...options,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    // The fallback used to be `Request failed (500)`, which is the shape of
    // message this app is trying not to show anyone: a status code is a fact
    // about HTTP, not about what the person just tried to do. It is reached
    // whenever the response carries no JSON body of its own — a gateway page,
    // a dropped connection, the CDN answering instead of us — which is exactly
    // when the reader is least able to do anything with a number.
    let message =
      res.status === 401
        ? 'You have been signed out. Please sign in again.'
        : res.status === 403
          ? 'Your account does not have permission to do that.'
          : res.status === 404
            ? 'That record could not be found. It may have been deleted.'
            : 'Something went wrong and the app could not finish that. Please try again in a few minutes — if it keeps happening, tell your church administrator.';
    try {
      const body = await res.json();
      // The server writes its own sentence for anything a person can act on;
      // only fall back when it did not.
      if (body.message) message = body.message;
    } catch {
      /* no JSON body — keep the sentence above */
    }
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  // PUT is "make this the state of that row", whether or not it existed —
  // what one cell of the Sunday sheet needs (create / update / clear in one
  // call). PATCH is still the right verb for editing a record that must
  // already exist.
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, form: FormData) =>
    request<T>(path, { method: 'POST', body: form }),
};

export { BASE as API_BASE };
