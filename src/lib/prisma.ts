import { PrismaClient } from '@prisma/client';

// Append NeonDB-friendly pool settings to the connection URL:
//   connection_limit=1  — one connection per serverless instance (avoids pool exhaustion)
//   pool_timeout=0      — don't queue waiting for a free connection; open a new one
//   connect_timeout=10  — fail fast on a dead socket so Prisma reconnects immediately
function buildDatasourceUrl(): string {
  const base = process.env.DATABASE_URL ?? '';
  const sep  = base.includes('?') ? '&' : '?';
  return `${base}${sep}connection_limit=1&pool_timeout=0&connect_timeout=10`;
}

function makePrismaClient() {
  return new PrismaClient({
    datasourceUrl: buildDatasourceUrl(),
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });
}

// In development Next.js hot-reloads the module but keeps the Node process alive,
// which would create a new PrismaClient (and new pool) on every HMR cycle.
// The global singleton prevents that — but we still get a fresh client on cold start.
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma = globalForPrisma.prisma ?? makePrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
