import type { Request } from "express";
import "./auth.types.js";

// The tenant a unit of work is being performed for (RFC-001 §9.2).
//
// Carried as an explicit, required parameter rather than read ambiently from
// the request. That is the whole point of the type: a service that takes a
// TenantContext cannot be called without one, while a service that reaches for
// ambient state compiles and runs identically whether or not the state was set
// — and an unset ambient context is indistinguishable from a correctly set one
// at the call site. That indistinguishability is precisely what makes tenant
// bugs invisible.
//
// It carries `userId` and nothing else. It is not a place to accumulate request
// metadata, roles, or permissions; it answers "on whose behalf", not "may
// they".
export type TenantContext = {
  userId: number;
};

// The owner of a record in the asynchronous pipeline, where ownership is still
// nullable.
//
// `TenantContext` comes from a session and always names a real User.
// `OwnershipContext` comes from a persisted row, and `Email.userId` is nullable
// until AC-5.11 backfills it and makes it required. A record ingested before
// ownership was recorded has no owner, and `null` is the honest representation
// of that — not a reason to fall back to an unscoped query.
//
// `null` is a tenant in its own right: unowned records match only other unowned
// records, which is exactly the pre-existing behaviour for pre-existing data.
// A `TenantContext` is structurally assignable to this type, so an authenticated
// caller can be passed wherever an owner is expected.
//
// This type disappears at AC-5.11. Once `userId` is NOT NULL there is only one
// kind of owner, and every signature below collapses onto `TenantContext`.
export type OwnershipContext = {
  userId: number | null;
};

// The owner of records that predate ownership tracking. Named rather than
// written inline as `{ userId: null }` so every such call site is greppable when
// AC-5.11 removes them.
export const UNOWNED: OwnershipContext = { userId: null };

// Derive the tenant from an authenticated request.
//
// Throws rather than returning null. Reaching this without `req.user` means a
// route was mounted without `requireAuth` — a wiring mistake, not a runtime
// condition a caller can recover from. Returning null would let that mistake
// degrade into an unscoped query, which is the failure this whole layer exists
// to prevent.
export const requireTenantContext = (req: Request): TenantContext => {
  const user = req.user;

  if (!user) {
    throw new Error(
      "requireTenantContext called without an authenticated user; the route is missing requireAuth",
    );
  }

  return {
    userId: user.id,
  };
};
