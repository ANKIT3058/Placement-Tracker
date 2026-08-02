import { Redis } from "ioredis";

// Redis connection used by the session store, kept separate from the BullMQ
// connection in `redis.ts` (RFC-001 §11.5).
//
// The two have incompatible operational requirements. BullMQ requires
// `maxmemory-policy noeviction` — an evicted job key is a silently lost job —
// while a session store is commonly deployed with an LRU policy. Applied to the
// queue instance, LRU destroys jobs under memory pressure. Sessions here expire
// by TTL only; nothing relies on eviction.
//
// RFC-001 §11.5 asks for a separate logical database at minimum and a separate
// instance in production. This is expressed as a separate URL rather than a
// `db` index because the deployed Redis is Upstash, which exposes database 0
// only — `SELECT` is unsupported, so a logical-database split is not available
// there. A distinct URL is the RFC's preferred form regardless.
//
// SESSION_REDIS_URL falls back to REDIS_URL so local development works with one
// Redis. Sharing is safe on the key level: sessions live under `sess:` and
// BullMQ under `bull:`. Production should point this at its own instance, and
// that instance is the only one whose eviction policy may be anything other
// than `noeviction`.
const configuredUrl = process.env.SESSION_REDIS_URL || process.env.REDIS_URL;

// Absent configuration is fatal in production and only there (RFC-001 §16.2):
// a session store that silently points somewhere unintended is a security
// failure, while local development and the test run must not require a Redis to
// import a module.
if (!configuredUrl && process.env.NODE_ENV === "production") {
  throw new Error(
    "SESSION_REDIS_URL or REDIS_URL is required in production for the session store",
  );
}

const sessionRedisUrl = configuredUrl || "redis://localhost:6379";

export const sessionRedis = new Redis(sessionRedisUrl, {
  // Deliberately NOT `maxRetriesPerRequest: null`, which `redis.ts` sets because
  // BullMQ requires it. That setting makes a command retry forever; on the
  // request path it turns a Redis outage into hung requests instead of fast
  // failures. Three attempts, then the request errors and the client can react.
  maxRetriesPerRequest: 3,

  // Connect on first command rather than on construction. Importing this module
  // must not open a socket: the test suite imports `app` (and therefore this
  // file) without ever touching a session, and an eager connection leaks a
  // handle that keeps Jest alive — the same reason `queues.ts` is mocked there.
  //
  // The cost is that an unreachable Redis surfaces on the first session
  // operation instead of at boot. For a request-path dependency that is the
  // right place for it to surface anyway.
  lazyConnect: true,
});

sessionRedis.on("connect", () => {
  console.log("✅ Redis (session) connected");
});

sessionRedis.on("error", (err: Error) => {
  console.error("❌ Redis (session) error:", err);
});
