// Single source of truth for the iiitd.org people-page security model.
// Used by the build (to write `_headers`) and by the edge worker (proxy mode),
// so static and proxied profiles always get identical protections.

/** Handles: lowercase, 2–39 chars, letters/digits/hyphens, no leading/trailing hyphen. */
export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])$/;

/** Handles nobody can claim (impersonation of the site, staff, or services). */
export const RESERVED_HANDLES = new Set([
  "admin", "administrator", "root", "staff", "support", "security", "abuse", "help",
  "iiitd", "iiit", "iiitdelhi", "official", "team", "placements", "placement", "people",
  "login", "logout", "account", "accounts", "api", "static", "assets", "www", "mail", "null",
]);

export const PROFILE_MODES = ["template", "static", "redirect", "proxy"];

/**
 * Where template/static profiles live inside the asset bundle. Never served directly:
 * the worker maps /@handle/... here and attaches the sandbox headers itself. (Path-matched
 * `_headers` rules are matched against the raw request path while assets are looked up by
 * the decoded path, so /%40handle/ would get the file without the rule — found in testing.)
 */
export const PEOPLE_ASSET_PREFIX = "/_p/";

/** Path segments a contributor's published files may use (`_next/`, `_astro/` build dirs are fine;
 *  the platform files in FORBIDDEN_FILENAMES are rejected separately). */
export const SAFE_FILENAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** Headers for first-party static files (landing page assets etc.). */
export const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
export const TEMPLATE_NAMES = ["card", "portfolio", "resume"];

/** File types a person may publish (mode: static) or attach (assets/). */
export const ALLOWED_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".json", ".map", ".txt", ".xml", ".webmanifest",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".pdf", ".mp4", ".webm",
]);
/** Platform control files that must never come from a contributor. */
export const FORBIDDEN_FILENAMES = new Set(["_headers", "_redirects", "_routes.json", "_worker.js", ".assetsignore"]);
export const LIMITS = { maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxFiles: 500 };

/**
 * Every response under /@handle/ is a CSP *sandbox* without `allow-same-origin`:
 * the browser gives the page an opaque origin, so its code cannot read iiitd.org
 * cookies or storage, and its requests to /placements/ are cross-site (no
 * SameSite=Lax cookies, unreadable responses, blocked by Fetch Metadata).
 * The URL stays iiitd.org/@handle.
 */
const SANDBOX_FOR_CODE =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

const COMMON = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=()",
  // Opaque-origin pages fetch their own module scripts, fonts and JSON in CORS mode,
  // so their (public) files must allow any origin. Never combined with credentials.
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

/** Contributor code (mode: static or proxy): scripts run, but sandboxed. */
export const CODE_PAGE_HEADERS = {
  ...COMMON,
  "Content-Security-Policy": `${SANDBOX_FOR_CODE}; frame-ancestors 'none'; base-uri 'self'`,
};

/** Template-rendered profiles: no scripts at all, inline styles only. */
export const TEMPLATE_PAGE_HEADERS = {
  ...COMMON,
  "Content-Security-Policy": [
    "default-src 'none'",
    "img-src https: data:",
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "sandbox allow-popups allow-popups-to-escape-sandbox",
  ].join("; "),
};

/**
 * Response headers a proxied server may send through. Everything else is dropped —
 * notably Set-Cookie (cookie tossing into /placements), Strict-Transport-Security,
 * Clear-Site-Data, Service-Worker-Allowed, Alt-Svc, Link, Refresh and any CSP/CORS
 * of its own, which could weaken or hijack iiitd.org as a whole.
 */
export const PROXY_RESPONSE_HEADER_ALLOWLIST = new Set([
  "content-type", "content-length", "content-encoding", "content-language", "content-range",
  "accept-ranges", "cache-control", "expires", "etag", "last-modified", "vary", "date", "age", "location",
]);

/** Request headers forwarded to a proxied server. Cookies and auth never leave iiitd.org. */
export const PROXY_REQUEST_HEADER_ALLOWLIST = new Set([
  "accept", "accept-language", "content-type", "content-length", "range",
  "if-none-match", "if-modified-since", "if-range", "user-agent",
]);

export function isSafeExternalUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === "iiitd.org" || host.endsWith(".iiitd.org")) return false; // no loops / self-reference
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
  if (/^[\d.]+$/.test(host) || host.includes(":")) return false; // IP literals
  return host.includes(".");
}
