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
