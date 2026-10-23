function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Bearer token callers must send. Only the gateway holds it.
  mcpToken: required('MCP_TOKEN'),
  wooUrl: required('WOO_URL'),
  wooKey: required('WOO_CONSUMER_KEY'),
  wooSecret: required('WOO_CONSUMER_SECRET'),
  // Public storefront URL, used to fix up permalinks (see woo.ts on why they come back as https).
  storePublicUrl: process.env.STORE_PUBLIC_URL ?? '',
  // Used to work out what "today" means for the store.
  storeTimezone: process.env.STORE_TIMEZONE ?? 'UTC',
  requestTimeoutMs: Number(process.env.WOO_TIMEOUT_MS ?? 10000),
};
