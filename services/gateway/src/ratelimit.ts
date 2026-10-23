/**
 * Fixed-window counter per caller (an API key for MCP clients, a user for the
 * chat). In memory, so each gateway replica counts on its own; good enough to
 * stop one runaway client from hammering the upstreams.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly rejected = new Map<string, number>();

  constructor(private readonly perMinute: number) {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  /** Returns true if the call may go ahead. */
  take(caller: string, server: string | null): boolean {
    if (this.perMinute <= 0) return true;
    const now = Date.now();
    let w = this.windows.get(caller);
    if (!w || now - w.start >= 60_000) {
      w = { start: now, count: 0 };
      this.windows.set(caller, w);
    }
    if (w.count >= this.perMinute) {
      const key = server ?? '-';
      this.rejected.set(key, (this.rejected.get(key) ?? 0) + 1);
      return false;
    }
    w.count++;
    return true;
  }

  get limit(): number {
    return this.perMinute;
  }

  /** Rejected calls per server slug since this replica started. */
  rejectedByServer(): Record<string, number> {
    return Object.fromEntries(this.rejected);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, w] of this.windows) if (now - w.start >= 60_000) this.windows.delete(k);
  }
}
