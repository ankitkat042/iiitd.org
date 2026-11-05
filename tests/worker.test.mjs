import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createHandler, rewriteLocation, toPublicPath } from "../edge/worker.js";

const site = {
  landingCsp: "script-src https://aframe.io 'sha256-x' 'unsafe-eval'",
  people: {
    ankit: { mode: "template" },
    eve: { mode: "static" },
    jane: { mode: "redirect", target: "https://jane.example.dev/" },
    proxied: { mode: "proxy", target: "https://proxied.example.dev/app" },
  },
};
let assetPaths;
let upstream;
const env = {
  PLACEMENTS_ORIGIN: "https://placements-1.asia-south1.run.app",
  EDGE_SHARED_SECRET: "edge-secret",
  ASSETS: {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      assetPaths.push(pathname);
      if (pathname === "/_p/eve/blog") return new Response(null, { status: 307, headers: { location: "/_p/eve/blog/" } });
      if (pathname.startsWith("/_p/") || pathname === "/" || pathname === "/people/") {
        return new Response("<h1>file</h1>", { headers: { "content-type": "text/html", "set-cookie": "x=1" } });
      }
      return new Response("Not found", { status: 404 });
    },
  },
};
const handler = createHandler(site);
const realFetch = globalThis.fetch;

beforeEach(() => {
  assetPaths = [];
  upstream = [];
  globalThis.fetch = async (url, init) => {
    upstream.push({ url: String(url), init });
    return new Response("<a href='/about'>x</a>", {
      headers: {
        "content-type": "text/html",
        "set-cookie": "__Secure-placements-session=attacker; Path=/placements/",
        "strict-transport-security": "max-age=0",
        "clear-site-data": "\"*\"",
        "service-worker-allowed": "/",
        "access-control-allow-origin": "https://evil.example",
        "cache-control": "max-age=60",
      },
    });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const get = (path, init) => handler.fetch(new Request(`https://iiitd.org${path}`, init), env);
const csp = (res) => res.headers.get("content-security-policy") ?? "";

describe("people pages are always sandboxed", () => {
  it("serves template profiles from the bundle with the no-script sandbox", async () => {
    const res = await get("/@ankit/");
    assert.deepEqual(assetPaths, ["/_p/ankit/"]);
    assert.match(csp(res), /default-src 'none'.*sandbox allow-popups/);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  it("serves static profiles with the scripts-allowed sandbox (never allow-same-origin)", async () => {
    const res = await get("/@eve/");
    assert.match(csp(res), /^sandbox allow-scripts/);
    assert.doesNotMatch(csp(res), /allow-same-origin/);
  });

  it("cannot be bypassed with percent-encoding of the handle or the @", async () => {
    for (const path of ["/%40eve/", "/@%65ve/", "/%40%45VE/"]) {
      const res = await get(path);
      if (res.status === 301) {
        assert.equal(res.headers.get("location"), "https://iiitd.org/@eve/");
        continue;
      }
      assert.match(csp(res), /^sandbox allow-scripts/, path);
    }
  });

  it("rejects double encoding and smuggled delimiters", async () => {
    for (const path of ["/%2540eve/", "/%255Fp/eve/", "/@eve/%3F", "/@eve/%5C..%5Cx"]) {
      assert.equal((await get(path)).status, 400, path);
    }
    assert.deepEqual(assetPaths, []);
  });

  it("never exposes the internal /_p/ location", async () => {
    const direct = await get("/_p/eve/");
    assert.equal(direct.status, 301);
    assert.equal(direct.headers.get("location"), "https://iiitd.org/@eve/");
    const res = await get("/@eve/blog");
    assert.equal(res.status, 307);
    assert.equal(res.headers.get("location"), "/@eve/blog/");
    assert.equal(toPublicPath("/_p/eve/x/", "eve"), "/@eve/x/");
  });

  it("lowercases handles, adds the trailing slash, and 404s unknown handles sandboxed", async () => {
    assert.equal((await get("/@Ankit/blog?x=1")).headers.get("location"), "https://iiitd.org/@ankit/blog?x=1");
    assert.equal((await get("/@ankit")).headers.get("location"), "https://iiitd.org/@ankit/");
    const missing = await get("/@nobody/");
    assert.equal(missing.status, 404);
    assert.match(csp(missing), /^sandbox /);
  });

  it("sends redirect-mode profiles to their own site", async () => {
    const res = await get("/@jane/anything");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://jane.example.dev/");
  });
});

describe("first-party pages", () => {
  it("gives the landing page its hash-based CSP", async () => {
    assert.equal(csp(await get("/")), site.landingCsp);
  });

  it("serves the directory without scripts", async () => {
    assert.match(csp(await get("/people/")), /default-src 'none'/);
  });
});

describe("placements forwarding", () => {
  it("forwards to Cloud Run and overwrites client-supplied edge headers", async () => {
    await get("/placements/students/?y=1", { headers: { "X-Edge-Auth": "forged", "CF-Connecting-IP": "203.0.113.9" } });
    const { url, init } = upstream[0];
    assert.equal(url, "https://placements-1.asia-south1.run.app/placements/students/?y=1");
    assert.equal(init.headers.get("x-edge-auth"), "edge-secret");
    assert.equal(init.headers.get("x-forwarded-host"), "iiitd.org");
    assert.equal(init.headers.get("x-client-ip"), "203.0.113.9");
    assert.equal(init.redirect, "manual");
  });

  it("fails closed when the origin or secret is not configured", async () => {
    const res = await handler.fetch(new Request("https://iiitd.org/placements/"), { ASSETS: env.ASSETS });
    assert.equal(res.status, 503);
    assert.equal(upstream.length, 0);
  });
});

describe("proxy mode hygiene", () => {
  it("never forwards cookies or credentials to the person's server", async () => {
    await get("/@proxied/page", { headers: { Cookie: "a=b", Authorization: "Bearer x", Accept: "text/html" } });
    const { url, init } = upstream[0];
    assert.equal(url, "https://proxied.example.dev/app/page");
    assert.equal(init.headers.get("cookie"), null);
    assert.equal(init.headers.get("authorization"), null);
    assert.equal(init.headers.get("accept"), "text/html");
    assert.equal(init.headers.get("x-forwarded-prefix"), "/@proxied");
  });

  it("drops headers that could plant cookies or weaken iiitd.org, and sandboxes the page", async () => {
    const res = await get("/@proxied/page");
    for (const h of ["set-cookie", "strict-transport-security", "clear-site-data", "service-worker-allowed"]) {
      assert.equal(res.headers.get(h), null, h);
    }
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("cache-control"), "max-age=60");
    assert.match(csp(res), /^sandbox allow-scripts/);
    assert.doesNotMatch(csp(res), /allow-same-origin/);
  });

  it("keeps the person's own redirects inside /@handle", () => {
    const base = new URL("https://proxied.example.dev/app");
    const up = new URL("https://proxied.example.dev/app/login");
    assert.equal(rewriteLocation("/app/home?x=1", up, base, "/@proxied"), "/@proxied/home?x=1");
    assert.equal(rewriteLocation("https://proxied.example.dev/app/a", up, base, "/@proxied"), "/@proxied/a");
    assert.equal(rewriteLocation("https://elsewhere.example/", up, base, "/@proxied"), "https://elsewhere.example/");
  });
});
