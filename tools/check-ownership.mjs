// PR gate: contributors may only touch people/<their-handle>/.
//   PR_AUTHOR=<login> BASE_SHA=<sha> node tools/check-ownership.mjs
// Ownership comes from the `github:` field on the BASE branch (so a PR can't take
// over a page by editing that field); for a brand-new folder, from the PR itself.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import YAML from "yaml";

const author = (process.env.PR_AUTHOR || "").toLowerCase();
const base = process.env.BASE_SHA;
if (!author || !base) {
  console.error("PR_AUTHOR and BASE_SHA are required");
  process.exit(2);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const maintainers = new Set(
  readFileSync("MAINTAINERS", "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim().toLowerCase()).filter(Boolean),
);
const changed = git("diff", "--name-only", "--no-renames", `${base}...HEAD`).split("\n").filter(Boolean);

function ownerAt(ref, handle) {
  try {
    const text = ref ? git("show", `${ref}:people/${handle}/profile.yml`) : readFileSync(`people/${handle}/profile.yml`, "utf8");
    return String(YAML.parse(text, { maxAliasCount: 0 })?.github || "").toLowerCase() || null;
  } catch {
    return null;
  }
}

const problems = [];
const handles = new Set();
for (const file of changed) {
  const m = file.match(/^people\/([^/]+)\//);
  if (m) handles.add(m[1]);
  else if (!maintainers.has(author)) problems.push(`${file}: only maintainers can change files outside people/<your-handle>/`);
}
for (const handle of handles) {
  if (maintainers.has(author)) continue;
  const owner = ownerAt(base, handle) ?? ownerAt(null, handle);
  if (owner !== author) {
    problems.push(`people/${handle}/: owned by ${owner ? `@${owner}` : "nobody"}, not @${author}`);
  }
}

if (problems.length) {
  console.error("Ownership check failed:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`Ownership OK for @${author}: ${[...handles].map((h) => `@${h}`).join(", ") || "no profile changes"}`);
