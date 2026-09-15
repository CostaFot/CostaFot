#!/usr/bin/env node
// Render the Projects section of README.md from the site's projects page.
//
// The source of truth is the front matter of src/content/pages/projects.md in
// CostaFot/costafotiadis.com: groups of projects with a title, blurb, preview
// image and links. This script fetches it, parses it with js-yaml (the same
// parser Astro uses for that file), renders a card grid, and replaces whatever
// sits between the PROJECTS markers in README.md. The daily workflow runs it
// and commits when the output changed.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "js-yaml";

const SITE_REPO = "CostaFot/costafotiadis.com";
const SITE_URL = "https://www.costafotiadis.com";
const SOURCE = `https://raw.githubusercontent.com/${SITE_REPO}/main/src/content/pages/projects.md`;
const IMAGES = `https://raw.githubusercontent.com/${SITE_REPO}/main/src/images/`;
const README = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");
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

const firstSentence = (blurb) => {
  const text = blurb.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/`/g, "");
  const match = text.match(/^(.+?[.!?])(\s|$)/s);
  return (match ? match[1] : text).trim();
};

const linksHtml = (links) =>
  links
    .map((l) => `<a href="${escape(absolute(l.href))}">${escape(l.label)}</a>`)
    .join(" · ");

function card(project) {
  const links = project.links ?? [];
  const primary = links.length ? escape(absolute(links[0].href)) : `${SITE_URL}/projects/`;
  const alt = escape(project.alt ?? project.title);
  const blurb = escape(firstSentence(project.blurb ?? ""));
  return (
    `<td width="${CELL_WIDTH}%" valign="top">` +
    `<a href="${primary}"><img src="${imageUrl(project.image)}" alt="${alt}" width="100%"></a>` +
    `<br><b>${escape(project.title)}</b><br><sub>${blurb}</sub>` +
    (links.length ? `<br><sub>${linksHtml(links)}</sub>` : "") +
    `</td>`
  );
}

function textEntry(project) {
  const links = project.links ?? [];
  return `<b>${escape(project.title)}</b>` + (links.length ? ` (${linksHtml(links)})` : "");
}

function renderGroup(group) {
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
      const cells = withImage.slice(i, i + COLUMNS).map(card);
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

const section = data.groups.map(renderGroup).join("\n\n");

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
