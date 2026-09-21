import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { databaseName, testUrls, withDatabase } from './db';

// Creates the test database if missing and applies all migrations (including
// enable_rls) to it before any spec runs.
export default async function globalSetup() {
  const { ownerUrl } = testUrls();
  const dbName = databaseName(ownerUrl);

  // The specs create and delete rows; never let them point at a real database.
  if (!/^[a-z0-9_]*test[a-z0-9_]*$/i.test(dbName)) {
    throw new Error(`Refusing to run tests against "${dbName}": database name must contain "test"`);
  }

  const admin = new PrismaClient({ datasourceUrl: withDatabase(ownerUrl, 'postgres') });
  try {
    const existing = await admin.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (existing.length === 0) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.$disconnect();
  }

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: ownerUrl },
    stdio: 'inherit',
  });
}
