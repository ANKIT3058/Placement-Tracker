import "./auth.types.js";
// Derive the tenant from an authenticated request.
//
// Throws rather than returning null. Reaching this without `req.user` means a
// route was mounted without `requireAuth` — a wiring mistake, not a runtime
// condition a caller can recover from. Returning null would let that mistake
// degrade into an unscoped query, which is the failure this whole layer exists
// to prevent.
export const requireTenantContext = (req) => {
    const user = req.user;
    if (!user) {
        throw new Error("requireTenantContext called without an authenticated user; the route is missing requireAuth");
    }
    return {
        userId: user.id,
    };
};
//# sourceMappingURL=tenant-context.js.map