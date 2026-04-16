import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

// PgBouncer session-mode has a limited pool (~15 connections on Supabase free tier).
// connection_limit=2  — keeps total connections low across concurrent API routes.
// pool_timeout=30     — wait up to 30s for a free slot before erroring.
// pgbouncer=true      — disables Prisma features incompatible with PgBouncer (advisory locks etc.)
function buildDbUrl(): string | undefined {
  const base = process.env.DATABASE_URL;
  if (!base) return undefined;
  try {
    const url = new URL(base);
    url.searchParams.set('connection_limit', '5');
    url.searchParams.set('pool_timeout', '60');
    url.searchParams.set('pgbouncer', 'true');
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
