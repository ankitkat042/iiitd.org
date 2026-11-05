# Add your page: `iiitd.org/@yourhandle`

Open a pull request that adds **one folder**: `people/<yourhandle>/`. CI checks it; a maintainer
merges; it's live in a minute. You can only ever change your own folder (CI enforces this using
the `github:` field).

Pick one of four modes:

| Mode | You provide | Best for |
| --- | --- | --- |
| [`template`](#1-template--fill-in-a-yaml-file) | a `profile.yml` | a clean page in five minutes, no code |
| [`static`](#2-static--your-own-htmlcssjs-or-a-built-typescriptreact-site) | your built site in `site/` | you already have a site (HTML, React, Vue, Svelte, Astro, …) |
| [`redirect`](#3-redirect--send-visitors-to-your-own-domain) | a URL | you already have `yourname.dev` |
| [`proxy`](#4-proxy--show-a-server-you-run) | a URL of a server you run | dynamic apps, your own backend |

Handles: 2–39 lowercase letters, digits or hyphens (`ankit`, `jane-doe`). Some names
(`admin`, `iiitd`, `placements`, …) are reserved.

---

## 1. `template` — fill in a YAML file

```yaml
# people/jane/profile.yml
handle: jane                 # must match the folder name
github: janedoe              # your GitHub username — only you can edit this folder
name: Jane Doe
mode: template
template: card               # card | portfolio | resume
headline: B.Tech CSE '26 · systems & networks
bio: I like making slow things fast.
avatar: assets/me.jpg        # put the image at people/jane/assets/me.jpg (or an https URL)
location: New Delhi
theme: auto                  # light | dark | auto
links:
  - { label: GitHub,   url: "https://github.com/janedoe",       icon: github }
  - { label: LinkedIn, url: "https://linkedin.com/in/janedoe",  icon: linkedin }
  - { label: Email,    url: "mailto:jane@example.com",          icon: email }
skills: [Go, Rust, eBPF]
projects:
  - { name: fastq, description: "Lock-free queue", url: "https://github.com/janedoe/fastq", tags: [Rust] }
experience:
  - { role: SDE Intern, organization: Example Corp, start: "May 2025", end: "Jul 2025", summary: "Built X." }
education:
  - { institution: IIIT Delhi, degree: B.Tech CSE, start: "2022", end: "2026" }
```

| Template | Looks like | Uses |
| --- | --- | --- |
| `card` | one centred card with your photo and big link buttons (link-in-bio) | name, headline, avatar, links |
| `portfolio` | single-page portfolio: intro, projects, skills, contact | + bio, projects, skills |
| `resume` | clean one-page CV, prints well | + experience, education |

Every field is optional except `handle`, `github`, `name`, `mode` (and `template`). Unknown
fields fail CI, so typos don't silently disappear. Full reference: `schema/profile.schema.json`.
Template pages run **no JavaScript at all**.

## 2. `static` — your own HTML/CSS/JS, or a built TypeScript/React site

```
people/jane/
  profile.yml      # handle, github, name, mode: static
  site/            # what gets published at iiitd.org/@jane/
    index.html
    assets/…
```

- **Commit the built output, not the source.** CI never runs your build (no `npm install` of
  third-party code in our pipeline). Build locally, copy the output folder into `site/`.
- **Build for the `/@jane/` base path**, or use only relative links:
  - Vite: `vite build --base=/@jane/` · Next.js static export: `basePath: "/@jane"` ·
    Astro: `base: "/@jane"` · Create React App: `"homepage": "/@jane"` · Hugo: `baseURL = "https://iiitd.org/@jane/"`.
- Allowed file types: html, css, js/mjs, json, map, txt, xml, webmanifest, svg, png, jpg, gif,
  webp, avif, ico, woff/woff2/ttf/otf, pdf, mp4, webm. ≤ 5 MB per file, ≤ 20 MB and 500 files
  total. File and folder names: letters, digits, `.`, `_`, `-` (build tools' `_next/`, `_astro/`
  are fine). No dotfiles, symlinks, `_headers`, `_redirects`.

### Your page runs in a browser sandbox

Your page is served with `Content-Security-Policy: sandbox allow-scripts …` so it can't touch
other parts of iiitd.org (or other people's pages). JavaScript, ES modules, `fetch()` of your
own files, forms, popups and new-tab links all work. **What doesn't:**

| Not available | Do this instead |
| --- | --- |
| `localStorage`, `sessionStorage`, IndexedDB, cookies | keep state in memory or the URL; wrap storage in `try { … } catch {}` (e.g. theme toggles) |
| Service workers / PWA install | use `redirect` or `proxy` mode to your own domain |
| Being embedded in an iframe | link to the page instead |

Most portfolios, React/Vue SPAs and static-site-generator output work unchanged. If yours
needs any of the above, use mode 3 or 4.

## 3. `redirect` — send visitors to your own domain

```yaml
handle: jane
github: janedoe
name: Jane Doe
mode: redirect
redirect: https://janedoe.dev/
```

`iiitd.org/@jane` (and anything under it) answers with a redirect to your site. Must be `https`.

## 4. `proxy` — show a server you run

```yaml
handle: jane
github: janedoe
name: Jane Doe
mode: proxy
proxy: https://jane-app.example.com/   # your server: Cloud Run, Render, Fly.io, a VM, GitHub Pages…
```

Visitors stay on `iiitd.org/@jane/…`; the edge fetches the matching path from your server.
You host and pay for the server; iiitd.org only forwards requests. Rules:

- Your server receives `X-Forwarded-Prefix: /@jane` and `X-Forwarded-Host: iiitd.org`. Serve
  under that prefix or use relative links. Root-relative links in HTML (`/about`) are rewritten
  to `/@jane/about` automatically; URLs built in JavaScript are not.
- Visitors' cookies and `Authorization` headers are never forwarded to you, and your
  `Set-Cookie`, `Strict-Transport-Security`, CORS/CSP and similar headers are dropped. The page
  gets the same sandbox as mode 2. If your app needs logins/sessions, use `redirect` to your own
  domain instead.
- Free proxy capacity is shared (Cloudflare free plan: 100k requests/day across the site).
  Heavy traffic belongs on your own domain.

---

## Check locally before opening the PR

```bash
npm ci --ignore-scripts
npm test                     # validates every profile, builds dist/, runs the tests
npx wrangler dev --local-protocol https   # browse https://localhost:8787/@yourhandle/
```

## Content rules

No impersonation, phishing, malware, or anything you wouldn't put on a résumé. Maintainers
can remove any page; repeated issues get the handle reserved.
