# iiitd.org

The front door for `iiitd.org`: the landing page, people pages at **`iiitd.org/@handle`**, and
the edge router that also serves [placement stats](https://github.com/ankitkat042/placement-stats)
at `iiitd.org/placements/`. Not associated with iiitd.ac.in.

**Want a page?** → [CONTRIBUTING.md](CONTRIBUTING.md). Three ready-made templates, or bring
your own static site, a redirect, or a server you run.

## How it fits together

```
browser ──HTTP/3 (QUIC) + TLS 1.3──▶ Cloudflare (iiitd.org, free plan)
                                        │
                              edge/worker.js — every request, decoded path decides headers
                                        │
   /                  landing page               site/            (hash-based CSP)
   /people/           directory                  generated
   /@handle/…         template / static pages    people/<handle>/ → asset bundle /_p/<handle>/ + sandbox CSP
   /@handle  → 302    redirect-mode profiles     registry
   /@handle/…         proxy-mode profiles        a server the person runs, sandboxed
   /placements/*      placement-stats            Cloud Run, with a shared-secret header
```

`npm run build` turns `site/` + `people/` into `dist/` plus `build/site.json` (each handle's
mode/target and the landing CSP); `wrangler deploy` ships both. CI validates every PR;
merges to `main` deploy automatically (two-job pipeline: contributor content is only processed
in a job without secrets).

## Why `/@handle` pages can't touch `/placements`

Browsers isolate by **origin** (`https://iiitd.org`), not by path. Without precautions, a
student's page at `/@eve/` would be the same origin as `/placements/`, so its JavaScript could:

- `fetch("/placements/private/")` — the browser attaches the visitor's session cookie (its path
  matches the *request*), and same-origin code can read the response: names, roll numbers, offers;
- load `/placements/fakeadmin/` and, if an admin visits, act as them (read the CSRF token, POST);
- set cookies for `/placements/` (cookie tossing), read `localStorage`, register service workers.

Cookie `Path=` scoping does **not** stop this — it was never a security boundary. What does,
while keeping the URL `iiitd.org/@handle`:

1. **CSP sandbox, attached by the edge worker to every `/@handle` response** (`tools/policy.mjs`).
   `Content-Security-Policy: sandbox allow-scripts …` *without* `allow-same-origin` makes the
   browser treat the page as a unique **opaque origin**, even though its URL is on iiitd.org.
   Its code cannot read iiitd.org cookies or storage, its requests to `/placements/` are
   cross-site (so `SameSite=Lax` cookies are not sent and responses are unreadable), and it
   cannot register service workers. It applies to whole page loads, popups and direct visits —
   it's a response header, not an iframe attribute. Template pages go further: no scripts at all.
   The worker runs for **every** request and decides on the fully decoded path. Static-asset
   `_headers` rules are not used: in testing, `/%40handle/` (an encoded `@`) served a profile
   *without* its rule, because rules match the raw path while files are found by the decoded one.
   Double-encoded paths are rejected (400) and the internal `/_p/` location redirects to `/@handle`.
2. **Fetch Metadata isolation in placement-stats** — cross-site requests are refused unless
   they are plain top-level GET navigations (defence in depth if a header were ever missing).
3. **Proxy hygiene** — for proxy-mode profiles the worker forwards no cookies/credentials and
   drops `Set-Cookie`, `Strict-Transport-Security`, `Clear-Site-Data`, `Service-Worker-Allowed`,
   `Alt-Svc`, `Link`, CORS and CSP headers from the person's server, so it cannot plant cookies
   in `/placements/` or weaken the domain.
4. **No bare `'self'` in placement-stats' CSP** — scripts may only come from
   `/placements/static/`, nonces and pinned CDNs, so an injected `<script src="/@eve/x.js">`
   wouldn't run there.
5. **Repository controls** — PR authors may only change `people/<their-handle>/` (checked
   against the `github:` field on `main`), files are allow-listed by type and size, platform
   files (`_headers`, `_redirects`, dotfiles, symlinks) are rejected, handles like `admin` are
   reserved.

Verified in headless Chrome against the local Workers runtime: the same script that can read
cookies, write `localStorage` and read `/placements/` responses from a normal page gets
`SecurityError`, `SecurityError` and a blocked fetch at `/@handle/` (and at `/%40handle/`), with
`self.origin === "null"`.

Trade-offs of the sandbox (documented for contributors): `localStorage`/`sessionStorage`,
cookies, IndexedDB and service workers are unavailable on `/@handle` pages. Phishing-style content is
a moderation problem the sandbox can't solve; maintainers review every new profile.

## Local development

```bash
npm ci --ignore-scripts
npm test          # validate, build dist/, run tests (node --test)
npx wrangler dev --local-protocol https   # full site at https://localhost:8787
                                          # (https matters: template CSP allows img-src https: only)
```

## Hosting and cost (Nov 2026)

| Piece | Where | Monthly |
| --- | --- | --- |
| Landing + people pages | Cloudflare Workers Static Assets, served through the worker | $0 |
| Edge worker | Cloudflare Workers Free: 100k requests/day across the whole site (every request runs the worker) | $0 (Workers Paid is $5/month if ever needed) |
| HTTP/3, TLS, DNS | Cloudflare Free | $0 |
| placement-stats | Cloud Run + Cloud SQL `db-f1-micro` (Mumbai) | ≈ $11–13 |
| Domain | Hostinger `.org` renewal ($17.99/yr) | ≈ $1.50 |

## Cutover checklist (one-time)

1. Cloudflare: add `iiitd.org` (free plan); at Hostinger switch the nameservers to Cloudflare's.
   SSL/TLS **Full (strict)**, HTTP/3 **on**, Always Use HTTPS **on**, min TLS 1.2.
2. `npx wrangler secret put EDGE_SHARED_SECRET`; set `PLACEMENTS_ORIGIN` in `wrangler.toml`.
3. Repo secrets `CLOUDFLARE_API_TOKEN` (Workers deploy scope) + `CLOUDFLARE_ACCOUNT_ID`, and
   repo variable `CLOUDFLARE_READY=true` to enable `deploy.yml`.
4. After the worker serves `iiitd.org`, disable GitHub Pages and delete `pages.yml`.
