// Prisma CLI configuration.
//
// The datasource URL is read from DATABASE_URL so the CLI and the application
// runtime resolve it from the same place: `src/lib/prisma.ts` builds its pg Pool
// from that same variable. Hardcoding a URL here decouples the two silently —
// you can migrate one database while the API talks to another, and neither side
// reports anything wrong — and it puts a live credential into version control.
//
// `env()` throws a clear error when the variable is unset, so a missing value
// fails loudly instead of falling back to something unintended.
//
// For local development, point DATABASE_URL at the PostgreSQL service defined in
// docker-compose.yml. See .env.example.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
