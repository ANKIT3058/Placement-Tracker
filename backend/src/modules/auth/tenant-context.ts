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

// The owner of a persisted record.
//
// AC-5.9 collapsed this onto `TenantContext`. It existed only for the migration
// window in which `userId` was nullable and a record could genuinely have no
// owner; every `userId` is now NOT NULL, so an owner derived from a row is the
// same kind of thing as an owner derived from a session, and the two types
// describe one concept.
//
// Kept as an alias rather than deleted because the distinction it marks is still
// real at the call site: a `TenantContext` is what the caller *claims* via their
// session, an `OwnershipContext` is what a row *records*. They must be produced
// differently — the second is re-derived from the database and never trusted
// from a request or a queue payload (RFC-001 §9.5) — even though they now carry
// the same shape.
export type OwnershipContext = TenantContext;

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
