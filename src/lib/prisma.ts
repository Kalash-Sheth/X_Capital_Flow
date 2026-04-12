import { PrismaClient } from '@prisma/client';

function makePrismaClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });
}

// In development Next.js hot-reloads the module but keeps the Node process alive,
// which would create a new PrismaClient (and new pool) on every HMR cycle.
// The global singleton prevents that — but we still get a fresh client on cold start.
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma = globalForPrisma.prisma ?? makePrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
