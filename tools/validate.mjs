// Validates every people/<handle>/ folder. Used by the build and by CI on each PR.
//   node tools/validate.mjs            -> validate all profiles, exit 1 on errors
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import YAML from "yaml";
import {
  ALLOWED_EXTENSIONS, FORBIDDEN_FILENAMES, HANDLE_PATTERN, LIMITS, RESERVED_HANDLES, SAFE_FILENAME, isSafeExternalUrl,
} from "./policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(await readFile(path.join(ROOT, "schema/profile.schema.json"), "utf8"));
// strictRequired is off because the mode-specific `required` clauses in allOf/then refer
// to properties defined at the top level of the schema (valid, but flagged by that rule).
const validateSchema = new Ajv({ allErrors: true, strict: true, strictRequired: false }).compile(schema);

/** Recursively list files under dir; reports symlinks/dotfiles/forbidden names as errors. */
async function walk(dir, rel = "", errors = []) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relPath = path.posix.join(rel, entry.name);
    const full = path.join(dir, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) errors.push(`${relPath}: symlinks are not allowed`);
    else if (entry.name.startsWith(".")) errors.push(`${relPath}: dotfiles are not allowed`);
    else if (FORBIDDEN_FILENAMES.has(entry.name)) errors.push(`${relPath}: reserved platform filename`);
    else if (!SAFE_FILENAME.test(entry.name)) errors.push(`${relPath}: use only letters, digits, '.', '_' and '-' in names`);
    else if (info.isDirectory()) files.push(...(await walk(full, relPath, errors)).files);
    else files.push({ relPath, full, size: info.size });
  }
  return { files, errors };
}

function checkFiles(files, errors, label) {
  let total = 0;
  for (const f of files) {
    total += f.size;
    const ext = path.extname(f.relPath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) errors.push(`${label}/${f.relPath}: file type ${ext || "(none)"} is not allowed`);
    if (f.size > LIMITS.maxFileBytes) errors.push(`${label}/${f.relPath}: larger than ${LIMITS.maxFileBytes / 1048576} MB`);
  }
  if (files.length > LIMITS.maxFiles) errors.push(`${label}: more than ${LIMITS.maxFiles} files`);
  if (total > LIMITS.maxTotalBytes) errors.push(`${label}: more than ${LIMITS.maxTotalBytes / 1048576} MB in total`);
}

export async function loadPerson(handle, peopleDir = path.join(ROOT, "people")) {
  const dir = path.join(peopleDir, handle);
  const errors = [];
  if (!HANDLE_PATTERN.test(handle)) errors.push(`handle "${handle}": use 2–39 lowercase letters, digits or hyphens`);
  if (RESERVED_HANDLES.has(handle)) errors.push(`handle "${handle}" is reserved`);

  let profile = {};
  try {
    profile = YAML.parse(await readFile(path.join(dir, "profile.yml"), "utf8"), { maxAliasCount: 0 }) ?? {};
  } catch (err) {
    errors.push(`profile.yml: ${err.code === "ENOENT" ? "missing" : err.message.split("\n")[0]}`);
    return { handle, dir, profile, errors, assets: [], site: [] };
  }
  if (!validateSchema(profile)) {
    for (const e of validateSchema.errors) errors.push(`profile.yml${e.instancePath || ""}: ${e.message}`);
  }
  if (profile.handle !== handle) errors.push(`profile.yml: handle must be "${handle}" (the folder name)`);
  if (profile.mode === "redirect" && !isSafeExternalUrl(profile.redirect)) errors.push("redirect: must be a public https URL outside iiitd.org");
  if (profile.mode === "proxy" && !isSafeExternalUrl(profile.proxy)) errors.push("proxy: must be a public https URL outside iiitd.org");

  // Optional folders: assets/ (images etc. for templates) and site/ (mode: static).
  const top = await readdir(dir);
  for (const name of top) {
    if (!["profile.yml", "assets", "site"].includes(name)) errors.push(`${name}: only profile.yml, assets/ and site/ are allowed`);
  }
  const assets = top.includes("assets") ? await walk(path.join(dir, "assets"), "", errors) : { files: [] };
  const site = top.includes("site") ? await walk(path.join(dir, "site"), "", errors) : { files: [] };
  checkFiles([...assets.files, ...site.files], errors, handle);

  if (profile.mode === "static" && !site.files.some((f) => f.relPath === "index.html")) {
    errors.push("mode: static needs site/index.html");
  }
  if (profile.mode !== "static" && site.files.length) errors.push("site/ is only used with mode: static");
  if (profile.avatar?.startsWith("assets/") && !assets.files.some((f) => `assets/${f.relPath}` === profile.avatar)) {
    errors.push(`avatar: ${profile.avatar} not found`);
  }
  return { handle, dir, profile, errors, assets: assets.files, site: site.files };
}

export async function loadPeople(peopleDir = path.join(ROOT, "people")) {
  const entries = await readdir(peopleDir, { withFileTypes: true }).catch(() => []);
  const people = [];
  for (const entry of entries) {
    if (entry.isDirectory()) people.push(await loadPerson(entry.name, peopleDir));
    else if (entry.name !== "README.md") people.push({ handle: entry.name, errors: ["only folders are allowed in people/"] });
  }
  return people.sort((a, b) => a.handle.localeCompare(b.handle));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const people = await loadPeople();
  let failed = 0;
  for (const p of people) {
    if (p.errors.length) {
      failed++;
      console.error(`✗ @${p.handle}`);
      for (const e of p.errors) console.error(`    ${e}`);
    } else {
      console.log(`✓ @${p.handle} (${p.profile.mode}${p.profile.template ? `: ${p.profile.template}` : ""})`);
    }
  }
  console.log(`${people.length - failed}/${people.length} profiles valid`);
  process.exit(failed ? 1 : 0);
}
