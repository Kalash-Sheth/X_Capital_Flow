import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

// Production: DATABASE_URL must point to Supabase transaction pooler (port 6543).
// pgbouncer=true  — disables Prisma features incompatible with PgBouncer (advisory locks, etc.)
// connection_limit — per-instance cap; transaction pooler handles actual multiplexing.
function buildDbUrl(): string | undefined {
  const base = process.env.DATABASE_URL;
  if (!base) return undefined;
  try {
    const url = new URL(base);
    if (!url.searchParams.has('pgbouncer'))        url.searchParams.set('pgbouncer', 'true');
    if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', '5');
    if (!url.searchParams.has('pool_timeout'))     url.searchParams.set('pool_timeout', '30');
    return url.toString();
  } catch {
    return base;
  }
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    datasources: { db: { url: buildDbUrl() } },
  });

// Always cache on global to prevent new clients on every hot-reload (dev) or
// module re-evaluation (prod). This is the standard Next.js singleton pattern.
globalForPrisma.prisma = prisma;
