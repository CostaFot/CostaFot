#!/usr/bin/env node
// Render the Projects section of README.md from the site's projects page.
//
// The source of truth is the front matter of src/content/pages/projects.md in
// CostaFot/costafotiadis.com: groups of projects with a title, blurb, preview
// image and links. This script fetches it, parses it with js-yaml (the same
// parser Astro uses for that file), renders a card grid, and replaces whatever
// sits between the PROJECTS markers in README.md. The weekly workflow runs it
// and commits when the output changed.
//
// A card with a `video:` (a short muted loop under the site's public/projects/)
// has its first frame as the image, which is mostly empty wallpaper. GitHub
// won't play a video from a URL in a README, so the loop is re-encoded with
// ffmpeg as an animated WebP under assets/projects/, named after a hash of the
// mp4 so it's only re-encoded (and only re-fetched by GitHub's image proxy)
// when the loop changes.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, join } from "node:path";
import yaml from "js-yaml";

const SITE_REPO = "CostaFot/costafotiadis.com";
const SITE_URL = "https://www.costafotiadis.com";
const SOURCE = `https://raw.githubusercontent.com/${SITE_REPO}/main/src/content/pages/projects.md`;
const IMAGES = `https://raw.githubusercontent.com/${SITE_REPO}/main/src/images/`;
const VIDEOS = `https://raw.githubusercontent.com/${SITE_REPO}/main/public`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");
const LOOPS_DIR = "assets/projects";
const LOOPS = `https://raw.githubusercontent.com/CostaFot/CostaFot/main/${LOOPS_DIR}/`;
const START = "<!-- PROJECTS:START -->";
const END = "<!-- PROJECTS:END -->";
const COLUMNS = 3;
const CELL_WIDTH = Math.floor(100 / COLUMNS);

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const escape = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const absolute = (href) => (href.startsWith("/") ? SITE_URL + href : href);

const imageUrl = (path) => IMAGES + path.split("images/", 2)[1];

// Loop files this run points at; anything else in LOOPS_DIR is stale.
const loops = new Set();

async function loopUrl(video) {
  const response = await fetch(VIDEOS + video);
  if (!response.ok) fail(`Fetching ${VIDEOS + video} failed: ${response.status}`);
  const mp4 = Buffer.from(await response.arrayBuffer());
  const hash = createHash("sha256").update(mp4).digest("hex").slice(0, 10);
  const name = `${basename(video, extname(video))}-${hash}.webp`;
  const out = join(ROOT, LOOPS_DIR, name);
  loops.add(name);
  if (existsSync(out)) return LOOPS + name;

  const tmp = mkdtempSync(join(tmpdir(), "loop-"));
  try {
    const input = join(tmp, basename(video));
    writeFileSync(input, mp4);
    mkdirSync(dirname(out), { recursive: true });
    // 640 px is twice a card's width in a three-column README table, 12 fps is
    // smooth enough for UI moving around, and q60 keeps a loop under a megabyte.
    const ffmpeg = spawnSync("ffmpeg", [
      "-v", "error", "-y", "-i", input, "-an",
      "-vf", "fps=12,scale=640:-2:flags=lanczos",
      "-c:v", "libwebp_anim", "-lossless", "0", "-q:v", "60", "-compression_level", "6", "-loop", "0",
      out,
    ], { stdio: "inherit" });
    if (ffmpeg.error || ffmpeg.status !== 0) fail(`ffmpeg failed on ${video}: ${ffmpeg.error ?? ffmpeg.status}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`Encoded ${LOOPS_DIR}/${name}`);
  return LOOPS + name;
}

const firstSentence = (blurb) => {
  const text = blurb.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/`/g, "");
  const match = text.match(/^(.+?[.!?])(\s|$)/s);
  return (match ? match[1] : text).trim();
};

const linksHtml = (links) =>
  links
    .map((l) => `<a href="${escape(absolute(l.href))}">${escape(l.label)}</a>`)
    .join(" · ");

async function card(project) {
  const links = project.links ?? [];
  const primary = links.length ? escape(absolute(links[0].href)) : `${SITE_URL}/projects/`;
  const alt = escape(project.alt ?? project.title);
  const blurb = escape(firstSentence(project.blurb ?? ""));
  const src = project.video ? await loopUrl(project.video) : imageUrl(project.image);
  return (
    `<td width="${CELL_WIDTH}%" valign="top">` +
    `<a href="${primary}"><img src="${src}" alt="${alt}" width="100%"></a>` +
    `<br><b>${escape(project.title)}</b><br><sub>${blurb}</sub>` +
    (links.length ? `<br><sub>${linksHtml(links)}</sub>` : "") +
    `</td>`
  );
}

function textEntry(project) {
  const links = project.links ?? [];
  return `<b>${escape(project.title)}</b>` + (links.length ? ` (${linksHtml(links)})` : "");
}

async function renderGroup(group) {
  let heading = escape(group.name);
  if (group.note) heading += ` <sub>${escape(group.note)}</sub>`;
  const withImage = group.projects.filter((p) => p.image);
  const without = group.projects.filter((p) => !p.image);

  const out = [`<h4>${heading}</h4>`];
  if (withImage.length) {
    out.push("<table>");
    for (let i = 0; i < withImage.length; i += COLUMNS) {
      // Pad short rows so the columns keep their width; a lone card would
      // otherwise stretch to the full table width.
      const cells = await Promise.all(withImage.slice(i, i + COLUMNS).map(card));
      while (cells.length < COLUMNS) cells.push(`<td width="${CELL_WIDTH}%"></td>`);
      out.push(`<tr>${cells.join("")}</tr>`);
    }
    out.push("</table>");
  }
  if (without.length) out.push(`<p>Also: ${without.map(textEntry).join(", ")}</p>`);
  return out.join("\n");
}

const response = await fetch(SOURCE);
if (!response.ok) fail(`Fetching ${SOURCE} failed: ${response.status}`);
const source = await response.text();

const match = source.match(/^---\n([\s\S]*?)\n---\n/);
if (!match) fail("projects.md has no front matter");
const data = yaml.load(match[1]);
if (!Array.isArray(data?.groups) || !data.groups.length) fail("projects.md has no groups");

const section = (await Promise.all(data.groups.map(renderGroup))).join("\n\n");

if (existsSync(join(ROOT, LOOPS_DIR))) {
  for (const name of readdirSync(join(ROOT, LOOPS_DIR))) {
    if (loops.has(name)) continue;
    rmSync(join(ROOT, LOOPS_DIR, name));
    console.log(`Removed ${LOOPS_DIR}/${name}`);
  }
}

const readme = readFileSync(README, "utf8");
if (!readme.includes(START) || !readme.includes(END)) {
  fail(`README.md is missing the ${START} / ${END} markers`);
}
const [head, rest] = readme.split(START, 2);
const tail = rest.split(END, 2)[1];
const updated = `${head}${START}\n${section}\n${END}${tail}`;

if (updated !== readme) {
  writeFileSync(README, updated);
  console.log("README.md updated");
} else {
  console.log("README.md unchanged");
}
