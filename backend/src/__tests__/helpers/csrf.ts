/* A legitimate browser, for suites that are not about CSRF.
 *
 * PR-8B put `requireCsrf` in front of every state-changing route, so a bare
 * `request(app).post(...)` — which carries no cookie jar and no header — is now
 * answered 403 before it reaches the handler. That is correct behaviour, and it
 * would silently gut any suite that kept building requests that way: the
 * assertions would still run, against a refusal rather than against the
 * contract they were written for.
 *
 * The fix is to make those suites behave the way a real browser does, NOT to
 * turn the check off. There is deliberately no test-environment bypass and no
 * way to skip the middleware from here: these helpers go through the real
 * `ensureCsrfCookie` on a real request and read the cookie it actually set, so
 * a suite using them proves the protected route works for a legitimate caller.
 * If the middleware broke, these would break with it.
 *
 * Lives outside `*.test.ts` so Jest does not collect it as a suite, and inside
 * `__tests__/` so `tsconfig.json` keeps it out of the production build.
 */

import request from "supertest";

type App = Parameters<typeof request.agent>[0];
type Agent = ReturnType<typeof request.agent>;

export const CSRF_COOKIE_NAME = "placement.csrf";

// Lower-cased: supertest passes header names through as given, and Node
// normalises them on arrival, so the casing here is cosmetic. It matches what
// the server reads.
export const CSRF_HEADER = "x-csrf-token";

const setCookies = (res: request.Response): string[] =>
  ([] as string[]).concat(
    (res.headers["set-cookie"] as unknown as string[]) ?? [],
  );

/* The CSRF token this browser now holds, read from the cookie the server set.
 *
 * `GET /` is used to obtain it rather than `/health` because it touches no
 * Prisma model: these helpers run inside suites whose Prisma doubles each mock
 * a different slice of the client, and a read that needed `$queryRaw` would
 * fail in most of them for reasons having nothing to do with CSRF.
 */
export const csrfTokenOf = async (agent: Agent): Promise<string> => {
  const res = await agent.get("/");

  const cookie = setCookies(res).find((value) =>
    value.startsWith(`${CSRF_COOKIE_NAME}=`),
  );

  if (!cookie) {
    throw new Error(
      "No CSRF cookie was issued — ensureCsrfCookie is not mounted",
    );
  }

  return decodeURIComponent(cookie.split("=")[1]!.split(";")[0]!);
};

/* A browser that has loaded the app: it holds the cookies an ordinary read set,
   and knows the token it must echo back. This is the shape every legitimate
   state-changing request has. */
export const browserWithToken = async (
  app: App,
): Promise<{ agent: Agent; token: string }> => {
  const agent = request.agent(app);

  return { agent, token: await csrfTokenOf(agent) };
};
