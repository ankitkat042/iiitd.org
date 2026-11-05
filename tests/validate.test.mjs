import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { isSafeExternalUrl } from "../tools/policy.mjs";
import { loadPerson } from "../tools/validate.mjs";

async function person(handle, yaml, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "people-"));
  const dir = path.join(root, handle);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "profile.yml"), yaml);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  return { root, dir, load: () => loadPerson(handle, root) };
}

const base = (handle, extra = "") => `handle: ${handle}\ngithub: someone\nname: Some One\n${extra}`;

describe("profile validation", () => {
  it("accepts a minimal template profile", async () => {
    const p = await person("jon", base("jon", "mode: template\ntemplate: card\n"));
    assert.deepEqual((await p.load()).errors, []);
  });

  it("rejects bad, reserved and mismatched handles", async () => {
    for (const handle of ["Jon", "j", "-jon", "admin"]) {
      const p = await person(handle, base(handle, "mode: template\ntemplate: card\n"));
      assert.ok((await p.load()).errors.length, handle);
    }
    const p = await person("jon", base("someone-else", "mode: template\ntemplate: card\n"));
    assert.ok((await p.load()).errors.some((e) => e.includes("folder name")));
  });

  it("rejects javascript: links and unknown fields", async () => {
    const p = await person("jon", base("jon", "mode: template\ntemplate: card\nlinks:\n  - {label: x, url: 'javascript:alert(1)'}\nscript: x\n"));
    const { errors } = await p.load();
    assert.ok(errors.some((e) => e.includes("/links/0/url")));
    assert.ok(errors.some((e) => e.includes("additional properties")));
  });

  it("only allows public https targets outside iiitd.org", () => {
    assert.ok(isSafeExternalUrl("https://jon.dev/"));
    for (const bad of ["http://jon.dev", "https://iiitd.org/x", "https://a.iiitd.org", "https://127.0.0.1", "https://localhost", "https://[::1]/", "https://u:p@jon.dev", "javascript:alert(1)"]) {
      assert.equal(isSafeExternalUrl(bad), false, bad);
    }
  });

  it("rejects platform control files, dotfiles, odd file types and symlinks in static sites", async () => {
    const p = await person("jon", base("jon", "mode: static\n"), {
      "site/index.html": "<h1>hi</h1>",
      "site/_headers": "/*\n  X: y",
      "site/.env": "SECRET=1",
      "site/run.php": "<?php ?>",
    });
    await symlink("/etc/passwd", path.join(p.dir, "site/passwd.txt"));
    const errors = (await p.load()).errors.join("\n");
    for (const needle of ["_headers", ".env", ".php", "symlink"]) assert.match(errors, new RegExp(needle.replace(".", "\\.")));
  });

  it("requires site/index.html for static mode and refuses YAML aliases", async () => {
    const p = await person("jon", base("jon", "mode: static\n"));
    assert.ok((await p.load()).errors.some((e) => e.includes("site/index.html")));
    const q = await person("ann", "a: &x [1]\nb: *x\n");
    assert.ok((await q.load()).errors.some((e) => e.startsWith("profile.yml")));
  });
});
