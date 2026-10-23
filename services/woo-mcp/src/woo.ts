type Query = Record<string, string | number | undefined>;

/**
 * Minimal client for the WooCommerce REST API (wc/v3).
 *
 * WooCommerce only accepts HTTP Basic auth when WordPress thinks the request
 * is HTTPS; over plain HTTP it insists on OAuth 1.0a. Inside the cluster we
 * talk plain HTTP to the ClusterIP service, so we send X-Forwarded-Proto: https,
 * which the official WordPress image's wp-config.php maps to $_SERVER['HTTPS'].
 */
export class WooClient {
  private readonly auth: string;

  constructor(
    private readonly baseUrl: string,
    key: string,
    secret: string,
    private readonly timeoutMs: number,
  ) {
    this.auth = 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
  }

  async request<T = unknown>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.baseUrl);
    // rest_route works with or without pretty permalinks.
    url.searchParams.set('rest_route', `/wc/v3${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: this.auth,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Forwarded-Proto': 'https',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? `timed out after ${this.timeoutMs}ms` : String(err);
      throw new Error(`WooCommerce request failed: ${reason}`);
    }

    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // keep raw text
    }
    if (!res.ok) {
      const message = (data as { message?: string })?.message ?? text.slice(0, 200);
      throw new Error(`WooCommerce returned ${res.status}: ${message}`);
    }
    return data as T;
  }
}
