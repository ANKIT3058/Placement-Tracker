// The authenticated principal, attached to the request by `requireAuth`.
//
// Deliberately not the whole `User` row. `status` and `deletedAt` are absent
// because by the time this exists they have already been checked — carrying them
// downstream invites a second, redundant, and eventually divergent check. What
// remains is identity and display data.
//
// `id` is the internal key and is what AC-5.7 will read to build the
// `TenantContext`. `publicId` is the only identifier that may leave the backend
// (RFC-001 §8.2).
export type AuthenticatedUser = {
  id: number;
  publicId: string;
  googleSub: string;
  email: string;
  name: string | null;
  imageUrl: string | null;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Optional at the type level because it is genuinely absent on every
      // unauthenticated route. A handler mounted behind `requireAuth` may treat
      // it as present; one that is not, may not. AC-5.7 removes the ambiguity
      // at the service boundary by taking an explicit `TenantContext` parameter
      // rather than reading this ambiently (RFC-001 §9.2).
      user?: AuthenticatedUser;
    }
  }
}

export {};
