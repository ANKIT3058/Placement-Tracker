// Loaded here rather than relied on from elsewhere. This module reads its
// configuration at import time, so it must not depend on some other module
// having imported dotenv first — an import-order change would otherwise make it
// fall back to `redis://localhost:6379` silently and fail only at sign-in.
import "dotenv/config";
import { createClient } from "redis";
// Redis connection used by the session store, kept separate from the BullMQ
// connection in `redis.ts` (RFC-001 §11.5).
//
// The two have incompatible operational requirements. BullMQ requires
// `maxmemory-policy noeviction` — an evicted job key is a silently lost job —
// while a session store is commonly deployed with an LRU policy. Applied to the
// queue instance, LRU destroys jobs under memory pressure. Sessions here expire
// by TTL only; nothing relies on eviction.
//
// WHY node-redis AND NOT ioredis
//
// `connect-redis` v10 declares `peerDependencies: { redis: ">=5" }` and issues
// its writes as `client.set(key, value, { expiration: { type: "EX", value } })`
// — the node-redis command signature, which takes an options object. ioredis
// takes variadic arguments (`'EX', ttl`) and stringifies anything else, so the
// same call reached Redis as `SET <key> <value> [object Object]` and was
// rejected with `ERR syntax error`. The store never wrote a session.
//
// The queue connection stays on ioredis: BullMQ requires it. Two clients from
// two libraries is the correct outcome here, not an inconsistency — each
// library is paired with the client it is built for.
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
    throw new Error("SESSION_REDIS_URL or REDIS_URL is required in production for the session store");
}
const sessionRedisUrl = configuredUrl || "redis://localhost:6379";
export const sessionRedis = createClient({
    url: sessionRedisUrl,
    // Fail commands immediately while the connection is down instead of queueing
    // them. This is the node-redis equivalent of the intent behind ioredis's
    // `maxRetriesPerRequest: 3`: on the request path a Redis outage should produce
    // a fast failure the caller can react to, never a hung request.
    disableOfflineQueue: true,
    socket: {
        // Reconnect indefinitely with bounded backoff. Returning an Error here
        // would close the client permanently and require a process restart to
        // recover from a transient outage; the offline queue being disabled is what
        // keeps individual requests fast meanwhile.
        reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
    },
});
// node-redis emits `error` on the client. Without a listener, a connection
// failure raises an unhandled 'error' event and terminates the process.
sessionRedis.on("error", (err) => {
    console.error("❌ Redis (session) error:", err.message);
});
sessionRedis.on("ready", () => {
    console.log("✅ Redis (session) connected");
});
// Connection is explicit and deliberately NOT performed at import time.
//
// node-redis does not connect implicitly — a command issued before `connect()`
// throws `ClientClosedError` rather than being queued — so something must call
// this. Doing it here at module scope would open a socket merely by importing
// the module, and the test suite imports `app` (and therefore this file)
// without ever touching a session; an eager connection leaks a handle that
// keeps Jest alive. That is the same reason `queues.ts` is mocked there.
//
// `server.ts` calls this during startup. Idempotent: node-redis resolves
// immediately when the client is already open.
export const connectSessionRedis = async () => {
    if (sessionRedis.isOpen) {
        return;
    }
    await sessionRedis.connect();
};
//# sourceMappingURL=session-redis.js.map