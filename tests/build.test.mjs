import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { renderProfile } from "../tools/build.mjs";
import { TEMPLATE_NAMES } from "../tools/policy.mjs";

// `npm test` runs the build first, so dist/ reflects the committed people/ folder.
const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

const hostile = {
  handle: "eve",
  github: "eve",
  name: `<script>alert(1)</script>"Eve'`,
  mode: "template",
  headline: "<img src=x onerror=alert(1)>",
  bio: "</style><script>alert(2)</script>",
  links: [{ label: "<b>x</b>", url: "https://eve.example/?a=\"><script>", icon: "website" }],
  skills: ["<svg onload=alert(3)>"],
  projects: [{ name: "<p>", description: "<iframe>", url: "https://eve.example" }],
  experience: [{ role: "<x>", organization: "<y>", summary: "<z>" }],
  education: [{ institution: "<i>", degree: "<d>" }],
};

describe("templates", () => {
  for (const template of TEMPLATE_NAMES) {
    it(`${template}: escapes every contributor-supplied string`, async () => {
      const html = await renderProfile({ ...hostile, template });
      assert.doesNotMatch(html, /<script>alert|<img src=x|<svg onload|<iframe>|<b>x<\/b>/);
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;(\/|&#x2F;)script&gt;/); // Mustache also escapes '/'
    });

    it(`${template}: only the template's own CSS is unescaped and there is no script`, async () => {
      const source = await read(`templates/${template}/template.html`);
      const raw = [...source.matchAll(/\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{&\s*([^}]+?)\s*\}\}/g)].map((m) => m[1] ?? m[2]);
      assert.deepEqual(raw, ["_css"]);
      assert.doesNotMatch(source, /<script|\son[a-z]+=/i);
      await read(`templates/${template}/LICENSE`); // upstream license must ship with the template
    });
  }
});

describe("build output", () => {
  it("registers every profile for the worker and keeps profile files out of public paths", async () => {
    const site = JSON.parse(await read("build/site.json"));
    assert.ok(Object.keys(site.people).length > 0);
    for (const [handle, person] of Object.entries(site.people)) {
      assert.ok(["template", "static", "redirect", "proxy"].includes(person.mode), handle);
      if (person.mode === "template" || person.mode === "static") {
        await read(`dist/_p/${handle}/index.html`); // served only via the worker at /@handle/
      }
    }
    await assert.rejects(read("dist/_headers")); // header rules live in the worker, not in path rules
  });

  it("allows the landing page's inline script by hash, not 'unsafe-inline'", async () => {
    const [site, landing] = await Promise.all([read("build/site.json").then(JSON.parse), read("site/index.html")]);
    const script = landing.match(/<script>([\s\S]*?)<\/script>/)[1];
    const hash = createHash("sha256").update(script).digest("base64");
    assert.ok(site.landingCsp.includes(`'sha256-${hash}'`));
    assert.doesNotMatch(site.landingCsp, /unsafe-inline/);
  });
});
