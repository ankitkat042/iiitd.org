// Builds dist/ (served by Cloudflare Workers Static Assets) from site/ and people/.
//   node tools/build.mjs
// Outputs: dist/** (landing page, /people/ directory, icons, and profiles under /_p/<handle>/),
//          build/site.json (per-handle mode/target + landing CSP, bundled into the edge worker).
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Mustache from "mustache";
import { PEOPLE_ASSET_PREFIX } from "./policy.mjs";
import { loadPeople } from "./validate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const BUILD = path.join(ROOT, "build");

/** Shared icons (LittleLink, MIT) published once at /templates/icons/. */
const ICON_BASE = "/templates/icons";
/** link icon -> [LittleLink button class, icon file] */
const LINK_STYLES = {
  github: ["button-github", "github"],
  linkedin: ["button-linked", "linkedin"],
  x: ["button-x", "x"],
  instagram: ["button-instagram", "instagram"],
  mastodon: ["button-mastodon", "mastodon"],
  scholar: ["button-google-scholar", "google-scholar"],
  youtube: ["button-default", "youtube"],
  email: ["button-default", "generic-email"],
  website: ["button-default", "generic-website"],
  blog: ["button-default", "generic-blog"],
  resume: ["button-default", "generic-review"],
  leetcode: ["button-default", "generic-code"],
  codeforces: ["button-default", "generic-code"],
  kaggle: ["button-default", "generic-code"],
};
const DEFAULT_LINK_STYLE = ["button-default", "generic-homepage"];
const icon = (name) => `${ICON_BASE}/${name}.svg`;
const period = (item) => [item.start, item.end].filter(Boolean).join(" — ");

const templateCache = new Map();
async function loadTemplate(name) {
  if (!templateCache.has(name)) {
    const dir = path.join(ROOT, "templates", name);
    templateCache.set(name, {
      html: await readFile(path.join(dir, "template.html"), "utf8"),
      css: await readFile(path.join(dir, "style.css"), "utf8"),
    });
  }
  return templateCache.get(name);
}

/** The data a template sees. Every string here is escaped by Mustache's {{ }}. */
export function profileView(profile) {
  const list = (key) => profile[key] ?? [];
  return {
    ...profile,
    initials: profile.name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase(),
    links: list("links").map((l) => {
      const [buttonClass, iconName] = LINK_STYLES[l.icon] ?? DEFAULT_LINK_STYLE;
      return { ...l, buttonClass, iconSrc: icon(iconName) };
    }),
    projects: list("projects").map((p) => ({
      ...p,
      tagsText: (p.tags ?? []).join(" · "),
      hasTags: (p.tags ?? []).length > 0,
    })),
    experience: list("experience").map((e) => ({ ...e, period: period(e) })),
    education: list("education").map((e) => ({ ...e, period: period(e) })),
    icons: {
      map: icon("generic-map"),
      calendar: icon("generic-calendar"),
      education: icon("generic-review"),
      experience: icon("generic-computer"),
    },
    hasLinks: list("links").length > 0,
    hasSkills: list("skills").length > 0,
    hasProjects: list("projects").length > 0,
    hasExperience: list("experience").length > 0,
    hasEducation: list("education").length > 0,
    hasResume: list("experience").length > 0 || list("education").length > 0,
    themeClass: `theme-${profile.theme ?? "auto"}`,
    canonical: `https://iiitd.org/@${profile.handle}/`,
  };
}

export async function renderProfile(profile) {
  const { html, css } = await loadTemplate(profile.template);
  // `_css` is the template's own stylesheet — the only unescaped value allowed.
  return Mustache.render(html, { ...profileView(profile), _css: css });
}


function inlineScriptHashes(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`,
  );
}

export async function build() {
  const people = await loadPeople();
  const invalid = people.filter((p) => p.errors.length);
  if (invalid.length) {
    for (const p of invalid) console.error(`✗ @${p.handle}\n    ${p.errors.join("\n    ")}`);
    throw new Error(`${invalid.length} invalid profile(s); run: node tools/validate.mjs`);
  }

  await rm(DIST, { recursive: true, force: true });
  await mkdir(BUILD, { recursive: true });
  await cp(path.join(ROOT, "site"), DIST, { recursive: true });
  await cp(path.join(ROOT, "templates/_icons"), path.join(DIST, ICON_BASE), { recursive: true });

  // A-Frame (pinned via SRI) compiles shaders with `new Function`, hence 'unsafe-eval'.
  const landing = await readFile(path.join(ROOT, "site/index.html"), "utf8");
  const landingCsp = [
    `script-src https://aframe.io ${inlineScriptHashes(landing).join(" ")} 'unsafe-eval'`,
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
  ].join("; ");

  const registry = {};
  const directory = [];
  for (const { handle, profile, dir, assets } of people) {
    // Internal location; the worker serves it at /@handle/ with the sandbox headers.
    const out = path.join(DIST, PEOPLE_ASSET_PREFIX, handle);
    if (profile.mode === "template" || profile.mode === "static") {
      if (assets.length) await cp(path.join(dir, "assets"), path.join(out, "assets"), { recursive: true });
      if (profile.mode === "template") {
        await mkdir(out, { recursive: true });
        await writeFile(path.join(out, "index.html"), await renderProfile(profile));
      } else {
        await cp(path.join(dir, "site"), out, { recursive: true });
      }
    }
    registry[handle] = { mode: profile.mode, ...(profile.redirect || profile.proxy ? { target: profile.redirect ?? profile.proxy } : {}) };
    directory.push({ handle, name: profile.name, headline: profile.headline ?? "", mode: profile.mode });
  }

  const dirTemplate = await loadTemplate("_directory");
  await mkdir(path.join(DIST, "people"), { recursive: true });
  await writeFile(
    path.join(DIST, "people/index.html"),
    Mustache.render(dirTemplate.html, { people: directory, count: directory.length, _css: dirTemplate.css }),
  );
  await writeFile(path.join(BUILD, "site.json"), JSON.stringify({ landingCsp, people: registry }, null, 2) + "\n");
  return { people: directory, registry };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { people, registry } = await build();
    const proxied = Object.values(registry).filter((p) => p.mode === "proxy").length;
    console.log(`Built ${people.length} profile(s) into dist/ (${proxied} proxied).`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
