// Prisma CLI configuration.
//
// This file configures the MIGRATION side only, and it deliberately points at
// the DIRECT (unpooled) database.
//
// Prisma 7 removed `url`/`directUrl` from schema.prisma, so the pooled/direct
// split is expressed by which side reads which variable:
//
//   Prisma Migrate / db  →  DIRECT_DATABASE_URL, here
//   Prisma Client        →  DATABASE_URL (pooled), via the PrismaPg adapter in
//                           src/lib/prisma.ts
//
// Migrate needs the direct endpoint because it takes a SESSION-level advisory
// lock to serialise concurrent deploys, and PgBouncer in transaction mode cannot
// hold one — the lock is acquired on one backend and released to another. DDL
// through a transaction pooler is unsafe for the same reason. The runtime wants
// the opposite: many short-lived queries across concurrent handlers, where
// connection reuse is the point.
//
// `env()` throws a clear error when the variable is unset, so a missing value
// fails loudly instead of silently falling back to the pooled URL — which would
// reintroduce exactly the problem this split exists to prevent.
//
// `dotenv/config` loads backend/.env so that lookup resolves.
//
// For local development both variables hold the same value: a plain Postgres
// (docker-compose.yml) has no pooler. See .env.example.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DIRECT_DATABASE_URL"),
  },
});
