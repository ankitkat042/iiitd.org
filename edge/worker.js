// iiitd.org edge worker (Cloudflare Workers + Static Assets). Every request comes here
// first (`run_worker_first = true`), and this code decides the security headers itself.
//
//   /placements/*   -> placement-stats on Cloud Run (shared-secret header)
//   /@handle/*      -> people pages: template/static files from the asset bundle (/_p/<handle>/),
//                      a redirect, or a proxied server — always with the CSP sandbox
//   everything else -> first-party static assets (landing page, /people/ directory, icons)
//
// Why not path-matched `_headers`: the asset layer looks files up by the *decoded* path but
// matches header rules against the *raw* one, so /%40handle/ served a profile without its
// sandbox in testing. Here every decision is made on one canonical, fully decoded path.
// Clients speak HTTP/3 (QUIC) + TLS 1.3 to Cloudflare; that is a zone setting.

import {
  BASE_HEADERS, CODE_PAGE_HEADERS, HANDLE_PATTERN, PEOPLE_ASSET_PREFIX,
  PROXY_REQUEST_HEADER_ALLOWLIST, PROXY_RESPONSE_HEADER_ALLOWLIST, TEMPLATE_PAGE_HEADERS,
} from "../tools/policy.mjs";
import generatedSite from "../build/site.json" with { type: "json" };

const UNSAFE_DECODED = /[%\\#?\0]/; // still-encoded, backslashes, or smuggled delimiters

export function createHandler(site) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      let path;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        return plain(400, "Bad request");
      }
      if (UNSAFE_DECODED.test(path)) return plain(400, "Bad request"); // e.g. double encoding

      if (path === "/placements" || path.startsWith("/placements/")) return forwardToPlacements(request, env, url);
      if (path.startsWith("/@")) return personRequest(request, env, url, path, site.people);
      if (path === PEOPLE_ASSET_PREFIX.slice(0, -1) || path.startsWith(PEOPLE_ASSET_PREFIX)) {
        const handle = path.slice(PEOPLE_ASSET_PREFIX.length).split("/")[0];
        return HANDLE_PATTERN.test(handle)
          ? redirect(url, `/@${path.slice(PEOPLE_ASSET_PREFIX.length)}${url.search}`, 301)
          : withHeaders(plain(404, "Not found"), CODE_PAGE_HEADERS);
      }
      const asset = await env.ASSETS.fetch(new Request(new URL(path + url.search, url.origin), request));
      return withHeaders(asset, sitePathHeaders(path, site));
    },
  };
}

export default createHandler(generatedSite);

function sitePathHeaders(path, site) {
  if (path === "/") return { ...BASE_HEADERS, "Content-Security-Policy": site.landingCsp };
  if (path.startsWith("/people/") || path.startsWith("/templates/")) return TEMPLATE_PAGE_HEADERS;
  return BASE_HEADERS;
}

async function forwardToPlacements(request, env, url) {
  if (!env.PLACEMENTS_ORIGIN || !env.EDGE_SHARED_SECRET) return plain(503, "Placements is not configured");
  const upstream = new URL(url.pathname + url.search, env.PLACEMENTS_ORIGIN);
  const headers = new Headers(request.headers);
  headers.set("X-Forwarded-Host", url.host);
  headers.set("X-Client-IP", request.headers.get("CF-Connecting-IP") || "");
  headers.set("X-Edge-Auth", env.EDGE_SHARED_SECRET); // overwrites anything the client sent
  return fetch(upstream, { method: request.method, headers, body: request.body, redirect: "manual" });
}

async function personRequest(request, env, url, path, people) {
  const [, raw = "", rest = ""] = path.match(/^\/@([^/]*)(\/.*)?$/) ?? [];
  const handle = raw.toLowerCase();
  if (!HANDLE_PATTERN.test(handle)) return withHeaders(plain(404, "No such profile"), CODE_PAGE_HEADERS);
  if (handle !== raw) return redirect(url, `/@${handle}${rest}${url.search}`, 301);

  const person = people[handle];
  if (!person) return withHeaders(plain(404, "No such profile"), CODE_PAGE_HEADERS);
  if (person.mode === "redirect") return Response.redirect(person.target, 302);
  if (rest === "") return redirect(url, `/@${handle}/${url.search}`, 308); // keep relative links inside
  if (person.mode === "proxy") return proxyPerson(request, url, handle, rest, person.target);

  const assetUrl = new URL(`${PEOPLE_ASSET_PREFIX}${handle}${rest}${url.search}`, url.origin);
  const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
  const response = withHeaders(asset, person.mode === "template" ? TEMPLATE_PAGE_HEADERS : CODE_PAGE_HEADERS);
  const location = response.headers.get("location");
  if (location) response.headers.set("location", toPublicPath(location, handle));
  return response;
}

/** Asset-layer redirects (e.g. adding a trailing slash) must point back at /@handle, not /_p/. */
export function toPublicPath(location, handle) {
  const internal = `${PEOPLE_ASSET_PREFIX}${handle}`;
  for (const prefix of [internal, encodeURI(internal)]) {
    if (location.startsWith(prefix)) return `/@${handle}${location.slice(prefix.length)}`;
  }
  return location;
}

/** Proxy mode: show a server the person runs at iiitd.org/@handle, sandboxed. */
export async function proxyPerson(request, url, handle, rest, target) {
  const prefix = `/@${handle}`;
  const base = new URL(target);
  const upstream = new URL(base.pathname.replace(/\/$/, "") + rest + url.search, base.origin);

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (PROXY_REQUEST_HEADER_ALLOWLIST.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set("X-Forwarded-Host", url.host);
  headers.set("X-Forwarded-Proto", "https");
  headers.set("X-Forwarded-Prefix", prefix);

  const hasBody = !["GET", "HEAD"].includes(request.method);
  const response = await fetch(upstream, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
  });

  const out = new Headers();
  for (const [name, value] of response.headers) {
    if (PROXY_RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())) out.append(name, value);
  }
  const location = out.get("location");
  if (location) out.set("location", rewriteLocation(location, upstream, base, prefix));

  let result = new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
  if ((out.get("content-type") || "").includes("text/html") && typeof HTMLRewriter !== "undefined") {
    result = rewriteRootRelativeLinks(result, prefix);
  }
  return withHeaders(result, CODE_PAGE_HEADERS);
}

/** Keep redirects inside /@handle when they point back at the person's own server. */
export function rewriteLocation(location, upstream, base, prefix) {
  const resolved = new URL(location, upstream);
  if (resolved.origin !== base.origin) return location; // external redirect: leave as is
  const basePath = base.pathname.replace(/\/$/, "");
  const path = resolved.pathname.startsWith(basePath) ? resolved.pathname.slice(basePath.length) : resolved.pathname;
  return `${prefix}${path.startsWith("/") ? path : `/${path}`}${resolved.search}${resolved.hash}`;
}

/** Root-relative links (/about) from a proxied site would escape to iiitd.org/about. */
function rewriteRootRelativeLinks(response, prefix) {
  const fix = (attr) => ({
    element(el) {
      const value = el.getAttribute(attr);
      if (value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith(`${prefix}/`)) {
        el.setAttribute(attr, prefix + value);
      }
    },
  });
  return new HTMLRewriter()
    .on("a[href]", fix("href"))
    .on("link[href]", fix("href"))
    .on("script[src]", fix("src"))
    .on("img[src]", fix("src"))
    .on("source[src]", fix("src"))
    .on("form[action]", fix("action"))
    .transform(response);
}

function withHeaders(response, headers) {
  const res = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) res.headers.set(name, value);
  res.headers.delete("set-cookie");
  return res;
}

function redirect(url, location, status) {
  return Response.redirect(new URL(location, url.origin).toString(), status);
}

function plain(status, body) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
