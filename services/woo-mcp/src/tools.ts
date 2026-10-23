import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { WooClient } from './woo.js';

const ORDER_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'] as const;

/** Moves a WordPress link onto the public storefront origin. */
function publicLink(link: string | undefined, publicUrl: string): string | undefined {
  if (!link || !publicUrl) return link;
  const url = new URL(link);
  return publicUrl + url.pathname + url.search;
}

// Trimmed shapes: the raw WooCommerce objects are huge and waste LLM context.
/* eslint-disable @typescript-eslint/no-explicit-any */
function product(p: any, publicUrl: string) {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    price: p.price,
    regular_price: p.regular_price,
    sale_price: p.sale_price,
    stock_status: p.stock_status,
    stock_quantity: p.stock_quantity,
    permalink: publicLink(p.permalink, publicUrl),
  };
}

function order(o: any) {
  return {
    id: o.id,
    status: o.status,
    date_created: o.date_created,
    total: o.total,
    currency: o.currency,
    payment_method: o.payment_method_title,
    customer: {
      name: `${o.billing?.first_name ?? ''} ${o.billing?.last_name ?? ''}`.trim(),
      email: o.billing?.email,
    },
    items: (o.line_items ?? []).map((li: any) => ({ name: li.name, quantity: li.quantity, total: li.total })),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
}

/** Calendar date (YYYY-MM-DD) in the store's timezone. */
function dateInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function buildServer(woo: WooClient, storeTimezone: string, storePublicUrl: string): McpServer {
  const server = new McpServer({ name: 'woocommerce', version: '0.1.0' });

  server.registerTool(
    'list_products',
    {
      annotations: { readOnlyHint: true },
      description: 'List products in the WooCommerce store. Optionally search by name.',
      inputSchema: {
        search: z.string().optional().describe('Text to search for in product names'),
        status: z.enum(['any', 'publish', 'draft', 'pending', 'private']).optional().describe('Default: any'),
        per_page: z.coerce.number().int().min(1).max(100).optional().describe('Default: 20'),
      },
    },
    async ({ search, status, per_page }) => {
      try {
        const rows = await woo.request<unknown[]>('GET', '/products', {
          query: { search, status: status ?? 'any', per_page: per_page ?? 20 },
        });
        return ok(rows.map((p) => product(p, storePublicUrl)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'create_product',
    {
      annotations: { readOnlyHint: false },
      description: 'Create a simple product. It is published to the storefront unless status is "draft".',
      inputSchema: {
        name: z.string().min(1),
        regular_price: z.union([z.string(), z.coerce.number()]).describe('Price in the store currency, e.g. 499'),
        description: z.string().optional(),
        status: z.enum(['publish', 'draft']).optional().describe('Default: publish'),
        stock_quantity: z.coerce.number().int().min(0).optional().describe('Set to track stock'),
      },
    },
    async ({ name, regular_price, description, status, stock_quantity }) => {
      try {
        const created = await woo.request('POST', '/products', {
          body: {
            name,
            type: 'simple',
            regular_price: String(regular_price),
            description,
            status: status ?? 'publish',
            ...(stock_quantity === undefined ? {} : { manage_stock: true, stock_quantity }),
          },
        });
        return ok(product(created, storePublicUrl));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_orders',
    {
      annotations: { readOnlyHint: true },
      description:
        'List orders, newest first. Use date="today" for orders placed today (store timezone), ' +
        'or a date as YYYY-MM-DD. Use after/before (YYYY-MM-DD) for a range.',
      inputSchema: {
        date: z.string().optional().describe('"today", "yesterday" or YYYY-MM-DD'),
        after: z.string().optional().describe('Orders on or after this date, YYYY-MM-DD'),
        before: z.string().optional().describe('Orders on or before this date, YYYY-MM-DD'),
        status: z.enum(['any', ...ORDER_STATUSES]).optional().describe('Default: any'),
        per_page: z.coerce.number().int().min(1).max(100).optional().describe('Default: 20'),
      },
    },
    async ({ date, after, before, status, per_page }) => {
      try {
        let from = after;
        let to = before;
        if (date) {
          const now = new Date();
          const day =
            date === 'today'
              ? dateInZone(now, storeTimezone)
              : date === 'yesterday'
                ? dateInZone(new Date(now.getTime() - 86_400_000), storeTimezone)
                : date;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`invalid date "${date}"`);
          from = to = day;
        }
        // WooCommerce reads these in the store's timezone.
        const rows = await woo.request<unknown[]>('GET', '/orders', {
          query: {
            after: from ? `${from}T00:00:00` : undefined,
            before: to ? `${to}T23:59:59` : undefined,
            status: status ?? 'any',
            per_page: per_page ?? 20,
          },
        });
        return ok(rows.map(order));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'get_order',
    {
      annotations: { readOnlyHint: true },
      description: 'Get one order by its ID.',
      inputSchema: { id: z.coerce.number().int().positive() },
    },
    async ({ id }) => {
      try {
        return ok(order(await woo.request('GET', `/orders/${id}`)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'update_order_status',
    {
      annotations: { readOnlyHint: false },
      description: 'Change the status of an order, e.g. to "completed".',
      inputSchema: {
        id: z.coerce.number().int().positive(),
        status: z.enum(ORDER_STATUSES),
      },
    },
    async ({ id, status }) => {
      try {
        return ok(order(await woo.request('PUT', `/orders/${id}`, { body: { status } })));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
