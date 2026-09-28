#!/usr/bin/env node
// Render the profile's hero: an Omarchy desktop drawn as one animated SVG.
//
// Every widget is one of the projects. The bar has the workspaces, a
// Markets-style ticker of the Command Palette extensions' installs, the
// Android Dev droid, the tray and a clock stamped with the build time; Clippy
// walks it and says a line from his book. Under it three tiled windows open:
// cava (for the Visualizer extension), fastfetch for costa@github, and a
// journalctl that prints the latest posts, the install count and the
// Graveyard's toll.
// Every number is fetched when this runs, so the daily workflow keeps it
// current. The font subset and Clippy's frames are embedded from assets/hero/
// (see hero-assets.mjs), so the SVG loads nothing else, which it couldn't
// anyway: GitHub shows it through an <img>.
//
//   node scripts/update-hero.mjs [out.svg]     (default dist/hero.svg)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "assets", "hero");
const OUT = process.argv[2] ?? join(ROOT, "dist", "hero.svg");
const USER = "CostaFot";
const SITE = "https://www.costafotiadis.com";
const TZ = "Europe/London";
const RAW = "https://raw.githubusercontent.com";
// Ticker symbols for the stats repo's app slugs.
const SYMBOLS = { adb: "ADB", market: "MKTS", agents: "AGNT", visualizer: "VIZR" };

// Tokyo Night, which the showcase loops use too.
const C = {
  bar: "#15161e", bg: "#1a1b26", fg: "#c0caf5", fg2: "#a9b1d6", dim: "#565f89", mute: "#737aa2",
  line: "#414868", blue: "#7aa2f7", cyan: "#7dcfff", green: "#9ece6a", red: "#f7768e",
  yellow: "#e0af68", magenta: "#bb9af7", orange: "#ff9e64", droid: "#3ddc84",
};

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// ---------------------------------------------------------------- data

async function get(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) fail(`Fetching ${url} failed: ${response.status}`);
  return response;
}

const github = (path) =>
  get(`https://api.github.com${path}`, {
    accept: "application/vnd.github+json",
    ...(process.env.GITHUB_TOKEN && { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
  }).then((r) => r.json());

async function fetchGithub() {
  const user = await github(`/users/${USER}`);
  const repos = [];
  for (let page = 1; ; page++) {
    const batch = await github(`/users/${USER}/repos?type=owner&per_page=100&page=${page}`);
    repos.push(...batch.filter((r) => !r.fork));
    if (batch.length < 100) break;
  }
  const langs = new Map();
  for (const r of repos) if (r.language) langs.set(r.language, (langs.get(r.language) ?? 0) + 1);
  return {
    since: new Date(user.created_at),
    followers: user.followers,
    repos: repos.length,
    stars: repos.reduce((sum, r) => sum + r.stargazers_count, 0),
    langs: [...langs].sort((a, b) => b[1] - a[1]).map(([name]) => name),
  };
}

const decode = (s) =>
  s
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

async function fetchPosts() {
  const xml = await (await get(`${SITE}/rss.xml`)).text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => ({
    title: decode(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").trim(),
    date: new Date(item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]),
    path: new URL(decode(item.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "/"), SITE).pathname.replace(/\/$/, ""),
  }));
  if (!items.length) fail("The RSS feed has no items");
  return items.sort((a, b) => b.date - a.date);
}

// Same sums as the site's /stats/ page: GitHub downloads plus Store
// acquisitions, last known value per column, and the change over 7 days.
async function fetchInstalls() {
  const apps = await (await get(`${RAW}/${USER}/stats/main/apps.json`)).json();
  return Promise.all(
    apps.map(async (app) => {
      const csv = await (await get(`${RAW}/${USER}/stats/refs/heads/data/data/${app.slug}.csv`)).text();
      const rows = csv.trim().split("\n").slice(1).map((line) => {
        const [date, gh, store] = line.split(",");
        return { date, gh: gh === "" ? null : Number(gh), store: store === "" ? null : Number(store) };
      });
      const totalAt = (i) => {
        const last = (key) => {
          for (let j = i; j >= 0; j--) if (rows[j][key] != null) return rows[j][key];
          return 0;
        };
        return last("gh") + last("store");
      };
      const end = rows.length - 1;
      const cutoff = new Date(Date.parse(rows[end].date) - 7 * 86400000).toISOString().slice(0, 10);
      let ref = 0;
      rows.forEach((r, i) => { if (r.date <= cutoff) ref = i; });
      const now = totalAt(end);
      const before = totalAt(ref);
      return { slug: app.slug, name: app.name, now, week: now - before, pct: before ? ((now - before) / before) * 100 : 0 };
    }),
  );
}

async function fetchGraveyard() {
  const rows = await (await get("https://graveyard.costafotiadis.com/api/scores?limit=500")).json();
  return {
    kills: rows.reduce((sum, r) => sum + (r.kills ?? 0), 0),
    slaps: rows.reduce((sum, r) => sum + (r.slaps ?? 0), 0),
    handles: rows.length,
  };
}

// The two repos pushed to most recently.
async function fetchPushes() {
  const events = await github(`/users/${USER}/events/public?per_page=100`);
  const latest = new Map();
  for (const e of events) {
    if (e.type !== "PushEvent") continue;
    const at = new Date(e.created_at);
    if (!(latest.get(e.repo.name) > at)) latest.set(e.repo.name, at);
  }
  return [...latest].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([repo, at]) => ({ repo: repo.split("/")[1], at }));
}

// Umami's all-time pageviews per path, through the hit counter.
async function fetchViews() {
  const rows = await (await get("https://hit-counter-production.up.railway.app/views?limit=1000")).json();
  return new Map(rows.map((r) => [r.path.replace(/\/$/, ""), r.views]));
}

async function fetchQuote(day) {
  const book = await (await get(`${RAW}/${USER}/omarchy-inappropriate-clippy/main/quotes.json`)).json();
  const usable = book.quotes.filter((q) => !q.nsfw && wrap(q.text, BUBBLE_COLS).length <= 3);
  if (!usable.length) fail("No quote in Clippy's book fits the bubble");
  return usable[day % usable.length].text;
}

// ---------------------------------------------------------------- text

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n) => n.toLocaleString("en-US");
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;

function wrap(text, cols) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > cols) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function ago(date, now) {
  const hours = Math.floor((now - date) / 3600000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30.4)} months ago`;
  return `${Math.round(days / 365.25)} years ago`;
}

function uptime(since, now) {
  let months = (now.getUTCFullYear() - since.getUTCFullYear()) * 12 + now.getUTCMonth() - since.getUTCMonth();
  if (now.getUTCDate() < since.getUTCDate()) months--;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y && plural(y, "year"), m && plural(m, "month")].filter(Boolean).join(", ") || "fresh";
}

// A run of coloured spans on one line: [[text, colour], ...].
const spans = (parts) =>
  parts.map(([text, color, extra = ""]) => `<tspan fill="${color}"${extra}>${esc(text)}</tspan>`).join("");

// ---------------------------------------------------------------- scene

// GitHub shows the README about 780 px wide, so 900 units puts the terminal
// text at about 11 px.
const W = 900;
const H = 420;
const BAR = 40;
const GAP_OUT = 18;
const GAP_IN = 10;
const WIN_Y = BAR + GAP_OUT;
const WIN_H = H - WIN_Y - GAP_OUT;
// Dwindle layout: cava over fastfetch on the left, the journal on the right.
const COL = 350;
const CAVA = { x: GAP_OUT, y: WIN_Y, w: COL, h: 90 };
const FF = { x: GAP_OUT, y: WIN_Y + CAVA.h + GAP_IN, w: COL, h: WIN_H - CAVA.h - GAP_IN };
const JR = { x: GAP_OUT + COL + GAP_IN, y: WIN_Y, w: W - 2 * GAP_OUT - COL - GAP_IN, h: WIN_H };
const PAD = 14;
const LH = 18; // terminal line height
const FS = 12; // terminal font size
const CW = FS * 0.6; // JetBrains Mono advances are 0.6 em
const BUBBLE_COLS = 28;

// Seeded so the stars stay put from one day to the next.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pct = (t, total) => `${((t / total) * 100).toFixed(3)}%`;

// Keyframes that hold each value until the next stop: [[ms, "css"], ...].
function steps(name, stops, total) {
  const frames = stops.map(([t, css]) => `${pct(t, total)}{${css}}`);
  frames.push(`100%{${stops.at(-1)[1]}}`);
  return `@keyframes ${name}{${frames.join("")}}`;
}

// The Omarchy logo from ~/.config/omarchy/branding/about.txt, as block runs.
const LOGO = `
██████████████████████████████████████████████████████
██████████████████████████████████████████████████████
████                     ████                     ████
████                     ████                     ████
████    █████████████████████         ████████    ████
████    █████████████████████         ████████    ████
████    ████                              ████    ████
████    ████                              ████    ████
████    ████                              ████    ████
████    ████                              ████    ████
████    ████                              ████    ████
████    ████                              ████    ████
████████████                              ████    ████
████████████                              ████    ████
████    ████                              ████    ████
████    ████                              ████    ████
████    ████                              ████    ████
████    ████                              ████    ████
████    ████                              ████    ████
████    ████                              ████    ████
████    ██████████████████████████████████████    ████
████    ██████████████████████████████████████    ████
████                     ████                     ████
████                     ████                     ████
█████████████████████████████     ████████████████████
█████████████████████████████     ████████████████████`.slice(1).split("\n");

function logo(x, y, width) {
  const cw = width / LOGO[0].length;
  const ch = cw * 2;
  const rects = [];
  LOGO.forEach((row, r) => {
    for (const m of row.matchAll(/█+/g)) {
      rects.push(`<rect x="${(x + m.index * cw).toFixed(2)}" y="${(y + r * ch).toFixed(2)}" width="${(m[0].length * cw).toFixed(2)}" height="${ch.toFixed(2)}"/>`);
    }
  });
  return { svg: `<g fill="url(#logo)">${rects.join("")}</g>`, height: LOGO.length * ch };
}

function render({ gh, posts, installs, graveyard, pushes, views, quote, now }) {
  const css = [];
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  const clockText = `${clock.weekday} ${clock.day} ${clock.month} ${clock.hour}:${clock.minute}`;

  // ---- wallpaper: the showcase's violet-to-pink with a field of stars
  const rand = rng(7);
  const stars = [];
  for (let i = 0; i < 90; i++) {
    const r = rand() < 0.15 ? 1.4 : rand() < 0.5 ? 0.9 : 0.6;
    const twinkle = rand() < 0.55;
    stars.push(
      `<circle cx="${(rand() * W).toFixed(1)}" cy="${(rand() * H).toFixed(1)}" r="${r}" fill="#fff" opacity="${(0.35 + rand() * 0.55).toFixed(2)}"` +
      (twinkle ? ` class="tw" style="animation-duration:${(2.5 + rand() * 4).toFixed(2)}s;animation-delay:-${(rand() * 6).toFixed(2)}s"` : "") +
      `/>`,
    );
  }
  css.push(`.tw{animation:tw 4s ease-in-out infinite}@keyframes tw{50%{opacity:.08}}`);
  css.push(`.shoot{animation:shoot 14s linear 4s infinite;opacity:0}@keyframes shoot{0%{opacity:0;transform:translate(0,0)}1%{opacity:1}7%{opacity:0;transform:translate(-340px,150px)}100%{opacity:0;transform:translate(-340px,150px)}}`);

  // ---- bar
  const barY = BAR / 2 + 5;
  const workspaces = [1, 2, 3, 4, 5]
    .map((n, i) => `<text x="${22 + i * 20}" y="${barY}" font-size="14" font-weight="${n === 1 ? 700 : 400}" fill="${n === 1 ? C.fg : C.dim}">${n}</text>`)
    .join("");

  const tickerX = 136;
  const tickerW = 400;
  const item = (a) => {
    const up = a.week > 0;
    const arrow = a.week > 0 ? "▲" : a.week < 0 ? "▼" : "■";
    const color = a.week > 0 ? C.green : a.week < 0 ? C.red : C.dim;
    return spans([[`${SYMBOLS[a.slug] ?? a.slug.slice(0, 4).toUpperCase()} `, C.fg2], [`${fmt(a.now)} ${arrow} ${up ? "+" : ""}${a.pct.toFixed(1)}%`, color]]);
  };
  const tickerText = installs.map(item).join(`<tspan fill="${C.line}">   ·   </tspan>`) + `<tspan fill="${C.line}">   ·   </tspan>`;
  const tickerChars = installs.reduce((n, a) => n + `${SYMBOLS[a.slug] ?? "XXXX"} ${fmt(a.now)} ▲ +${a.pct.toFixed(1)}%`.length + 7, 0);
  const tickerLen = tickerChars * 13 * 0.6;
  css.push(`.ticker{animation:ticker ${(tickerLen / 28).toFixed(1)}s linear infinite}@keyframes ticker{to{transform:translateX(-${tickerLen.toFixed(1)}px)}}`);

  const clockX = W - GAP_OUT;
  const tray = [
    ["\u{F0079}", W - 164], // battery
    ["\u{F057E}", W - 188], // volume
    ["\u{F0928}", W - 212], // wifi
    ["\u{F00AF}", W - 234], // bluetooth
  ].map(([glyph, x]) => `<text x="${x}" y="${barY + 1}" font-size="15" text-anchor="middle" fill="${C.fg2}">${glyph}</text>`).join("");
  // The Android Dev plugin's droid: grey until a phone connects.
  const droidX = W - 266;
  css.push(`.droid{animation:droid .5s ease 3.2s both}@keyframes droid{from{fill:${C.dim}}to{fill:${C.droid}}}`);
  css.push(`.ping{animation:ping 1.1s ease-out 3.2s both;transform-box:fill-box;transform-origin:center}@keyframes ping{0%{opacity:0;transform:scale(.4)}15%{opacity:.8}100%{opacity:0;transform:scale(2.2)}}`);

  // ---- windows
  const winOpen = (name, delay) =>
    `.${name}{animation:popin .28s cubic-bezier(.2,.9,.3,1.15) ${delay}ms both;transform-box:fill-box;transform-origin:center}`;
  css.push(`@keyframes popin{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}`);
  // Each window takes the focus (the blue border) when it opens.
  const OPEN = { cava: 100, ff: 600, jr: 2000 };
  css.push(winOpen("cvwin", OPEN.cava), winOpen("ffwin", OPEN.ff), winOpen("jrwin", OPEN.jr));
  css.push(`@keyframes blur{from{stroke:${C.blue}}to{stroke:${C.line}}}`);
  css.push(`.cvborder{animation:blur .01s linear ${OPEN.ff}ms both}.ffborder{animation:blur .01s linear ${OPEN.jr}ms both}`);
  css.push(`.show{animation:show .01s linear both}@keyframes show{from{opacity:0}to{opacity:1}}`);
  css.push(`.blink{animation:blink 1s step-end infinite}@keyframes blink{50%{opacity:0}}`);

  const typed = (x, y, text, start, speed, color) =>
    [...text].map((ch, i) =>
      `<tspan fill="${color}" class="show" style="animation-delay:${start + i * speed}ms">${esc(ch)}</tspan>`).join("");

  const frame = (win, border) =>
    `<rect x="${win.x + 1}" y="${win.y + 1}" width="${win.w - 2}" height="${win.h - 2}" fill="${C.bg}" fill-opacity=".9" stroke="${C.blue}" stroke-width="2" class="${border}"/>`;

  // cava: bars that bounce, the bass on the left the loudest.
  const bars = 30;
  const barGap = 3;
  const barW = (CAVA.w - 2 * PAD - barGap * (bars - 1)) / bars;
  const barMax = CAVA.h - 2 * PAD + 4;
  const barBase = CAVA.y + CAVA.h - PAD + 2;
  const beat = rng(11);
  const cavaBars = [];
  for (let i = 0; i < bars; i++) {
    const env = 0.35 + 0.65 * Math.exp(-i / 11);
    const stops = Array.from({ length: 9 }, () => (0.12 + beat() * 0.88 * env).toFixed(2));
    stops[8] = stops[0];
    css.push(`@keyframes cv${i}{${stops.map((v, k) => `${(k * 12.5).toFixed(1)}%{transform:scaleY(${v})}`).join("")}}`);
    cavaBars.push(
      `<rect x="${(CAVA.x + PAD + i * (barW + barGap)).toFixed(2)}" y="${(barBase - barMax).toFixed(2)}" width="${barW.toFixed(2)}" height="${barMax}" ` +
      `class="cv" style="animation-name:cv${i};animation-duration:${(1.4 + beat() * 0.9).toFixed(2)}s;animation-delay:-${(beat() * 2).toFixed(2)}s"/>`,
    );
  }
  css.push(`.cv{animation:1.8s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 100%}`);
  const cava = `
  <g class="cvwin">
    ${frame(CAVA, "cvborder")}
    <g fill="url(#cava)">${cavaBars.join("")}</g>
  </g>`;

  // fastfetch
  const ffTop = FF.y + PAD + 12;
  const ffCmd = "fastfetch";
  const ffType = OPEN.ff + 250;
  const ffOut = ffType + ffCmd.length * 55 + 200;
  const LOGO_W = 92;
  const mark = logo(FF.x + PAD + 2, ffTop + 16, LOGO_W);
  const infoX = FF.x + PAD + 2 + LOGO_W + 18;
  const infoCols = Math.floor((FF.x + FF.w - PAD - infoX) / CW);
  // As many languages as fit after "Languages: ".
  let langs = gh.langs[0] ?? "";
  for (const l of gh.langs.slice(1)) if (`Languages: ${langs}, ${l}`.length <= infoCols) langs += `, ${l}`; else break;
  const info = [
    [[`costa`, C.blue, ` font-weight="700"`], [`@`, C.fg], [`github`, C.blue, ` font-weight="700"`]],
    [[`────────────`, C.line]],
    [[`OS`, C.blue], [`: Omarchy x86_64`, C.fg]],
    [[`Host`, C.blue], [`: Just Eat Takeaway`, C.fg]],
    [[`Uptime`, C.blue], [`: ${uptime(gh.since, now)}`, C.fg]],
    [[`Packages`, C.blue], [`: ${gh.repos} (github)`, C.fg]],
    [[`Shell`, C.blue], [`: ${gh.langs[0]?.toLowerCase() ?? "bash"}`, C.fg]],
    [[`Languages`, C.blue], [`: ${langs}`, C.fg]],
    [[`Stars`, C.blue], [`: ${fmt(gh.stars)} `, C.fg], [`★`, C.yellow]],
    [[`Posts`, C.blue], [`: ${posts.length} on costafotiadis.com`, C.fg]],
  ];
  const infoSvg = info.map((parts, i) => `<text x="${infoX}" y="${ffTop + 22 + i * LH}">${spans(parts)}</text>`).join("");
  const swatchY = ffTop + 22 + info.length * LH - 4;
  const palette = [C.line, C.red, C.green, C.yellow, C.blue, C.magenta, C.cyan, C.fg2];
  const swatches = palette.map((c, i) => `<rect x="${infoX + i * 19}" y="${swatchY}" width="19" height="12" fill="${c}"/>`).join("");
  // A sheen that crosses the logo once fastfetch has printed.
  css.push(`.sheen{animation:sheen 1.4s ease-in-out ${ffOut + 250}ms both}@keyframes sheen{from{transform:translateX(-160px)}to{transform:translateX(200px)}}`);

  const fastfetch = `
  <g class="ffwin">
    ${frame(FF, "ffborder")}
    <text x="${FF.x + PAD}" y="${ffTop}">${spans([["❯ ", C.green]])}${typed(0, 0, ffCmd, ffType, 55, C.fg)}</text>
    <g class="show" style="animation-delay:${ffOut}ms">
      <clipPath id="logoclip">${mark.svg.replace(/ fill="url\(#logo\)"/, "")}</clipPath>
      ${mark.svg}
      <g clip-path="url(#logoclip)"><rect class="sheen" x="${FF.x}" y="${ffTop}" width="70" height="${mark.height + 30}" fill="url(#sheen)" transform="skewX(-20)"/></g>
      ${infoSvg}
      ${swatches}
    </g>
  </g>`;

  // journalctl
  const jrCols = Math.floor((JR.w - PAD * 2) / CW);
  const jrCmd = "journalctl --user -fu costa -o cat";
  const jrType = OPEN.jr + 350;
  const jrStart = jrType + jrCmd.length * 45 + 350;
  const out = []; // [[parts...], ...] one entry per screen line
  const push = (parts) => {
    // Wrap a line that runs past the window, carrying the colour of the
    // span it breaks in and indenting the continuation.
    const flat = parts.flatMap(([text, color]) => [...text].map((ch) => [ch, color]));
    for (let i = 0; i < flat.length; ) {
      const width = i === 0 ? jrCols : jrCols - 2;
      let end = Math.min(flat.length, i + width);
      if (end < flat.length) {
        const space = flat.slice(i, end).map(([c]) => c).lastIndexOf(" ");
        if (space > 0) end = i + space + 1;
      }
      const chunk = flat.slice(i, end);
      const line = [];
      for (const [ch, color] of chunk) {
        if (line.length && line.at(-1)[1] === color) line.at(-1)[0] += ch;
        else line.push([ch, color]);
      }
      out.push(i === 0 ? line : [["  ", C.fg], ...line]);
      i = end;
    }
  };
  for (const post of posts.slice(0, 2)) {
    push([["blog: ", C.mute], [`"${post.title}"`, C.cyan], [` ${ago(post.date, now)}`, C.dim]]);
  }
  const read = posts.map((p) => ({ ...p, views: views.get(p.path) ?? 0 })).sort((a, b) => b.views - a.views)[0];
  if (read?.views) push([["umami: ", C.mute], ["most read ", C.fg2], [`"${read.title}"`, C.cyan], [`, ${plural(read.views, "view")}`, C.fg2]]);
  for (const p of pushes) push([["git: ", C.mute], ["pushed to ", C.fg2], [p.repo, C.magenta], [` ${ago(p.at, now)}`, C.dim]]);
  const total = installs.reduce((n, a) => n + a.now, 0);
  const week = installs.reduce((n, a) => n + a.week, 0);
  push([["store: ", C.mute], [`${fmt(total)} installs across ${installs.length} extensions, `, C.fg2], [`+${fmt(week)} this week`, C.green]]);
  push([["graveyard: ", C.mute], [`${plural(graveyard.slaps, "slap")} and ${plural(graveyard.kills, "kill")} from ${plural(graveyard.handles, "handle")}`, C.fg2]]);
  push([["clippy.service: Main process exited, code=killed, status=SIGSLAP", C.red]]);
  push([["clippy.service: Failed with result 'signal'.", C.yellow]]);
  push([[`clippy.service: Scheduled restart job, restart counter is at ${fmt(graveyard.kills)}.`, C.dim]]);
  push([["Started clippy.service - Inappropriate Clippy.", C.green]]);

  const jrTop = JR.y + PAD + 12;
  const lineDelay = (i) => jrStart + i * 260;
  const jrLines = out
    .map((parts, i) => `<text x="${JR.x + PAD}" y="${jrTop + (i + 1) * LH}" class="show" style="animation-delay:${lineDelay(i)}ms">${spans(parts)}</text>`)
    .join("");
  const cursorLine = out.length + 1;
  // The cursor rides along while the command types, then waits on the last line.
  const cmdCursorX = JR.x + PAD + 2 * CW;
  const cursorStops = [[0, "opacity:0"], [OPEN.jr, "opacity:1;transform:translateX(0)"]];
  for (let i = 0; i < jrCmd.length; i++) {
    cursorStops.push([jrType + i * 45, `opacity:1;transform:translateX(${((i + 1) * CW).toFixed(2)}px)`]);
  }
  const cursorOff = jrStart - 40;
  cursorStops.push([cursorOff, "opacity:0"]);
  css.push(steps("cmdcur", cursorStops, cursorOff + 1));
  css.push(`.cmdcur{animation:cmdcur ${cursorOff + 1}ms step-end both}`);

  const journal = `
  <g class="jrwin">
    ${frame(JR, "jrborder")}
    <text x="${JR.x + PAD}" y="${jrTop}">${spans([["❯ ", C.green]])}${typed(0, 0, jrCmd, jrType, 45, C.fg)}</text>
    <rect class="cmdcur" x="${cmdCursorX}" y="${jrTop - FS + 2}" width="${CW}" height="${FS + 2}" fill="${C.fg}"/>
    ${jrLines}
    <g class="show" style="animation-delay:${lineDelay(out.length)}ms">
      <text x="${JR.x + PAD}" y="${jrTop + cursorLine * LH}">${spans([["❯ ", C.green]])}</text>
      <rect class="blink" x="${JR.x + PAD + 2 * CW}" y="${jrTop + cursorLine * LH - FS + 2}" width="${CW}" height="${FS + 2}" fill="${C.fg}"/>
    </g>
  </g>`;

  // ---- Clippy: waves by the tray, walks to the left of the ticker, gets
  // your attention, says his line, and walks back.
  const sheet = JSON.parse(readFileSync(join(ASSETS, "clippy.json"), "utf8"));
  const png = readFileSync(join(ASSETS, "clippy.png")).toString("base64");
  const cH = 44;
  const cW = (sheet.width / sheet.height) * cH;
  const A = tickerX + tickerW + 12;
  const B = tickerX + 20;
  const plan = [];
  let t = 0;
  const rest = (ms) => { plan.push([t, 0]); t += ms; };
  const play = (name) => { for (const [cell, d] of sheet.animations[name]) { plan.push([t, cell]); t += d; } };
  rest(600);
  play("Wave");
  const walk1 = [t, t + 2200];
  rest(2200);
  play("GetAttention");
  const talk = t;
  play("Explain");
  rest(Math.max(0, talk + 7200 - t));
  const walk2 = [t, t + 2200];
  rest(2200);
  rest(3200);
  const loop = t;
  css.push(steps("cframes", plan.map(([at, cell]) => [at, `transform:translateX(-${cell * sheet.width}px)`]), loop));
  css.push(`.cframes{animation:cframes ${loop}ms step-end infinite}`);
  const at = (x) => `transform:translateX(${x}px)`;
  css.push(`@keyframes cwalk{0%,${pct(walk1[0], loop)}{${at(A)}}${pct(walk1[1], loop)},${pct(walk2[0], loop)}{${at(B)}}${pct(walk2[1], loop)},100%{${at(A)}}}`);
  css.push(`.cwalk{animation:cwalk ${loop}ms ease-in-out infinite}`);
  // A little bob while he walks.
  const bob = [[0, "transform:translateY(0)"]];
  for (const [from, to] of [walk1, walk2]) {
    for (let s = from, up = true; s < to; s += 140, up = !up) bob.push([s, `transform:translateY(${up ? -2 : 0}px)`]);
    bob.push([to, "transform:translateY(0)"]);
  }
  css.push(steps("cbob", bob, loop), `.cbob{animation:cbob ${loop}ms step-end infinite}`);

  const bubbleLines = wrap(quote, BUBBLE_COLS);
  const bFS = 12;
  const bw = BUBBLE_COLS * bFS * 0.6 + 26;
  const bh = bubbleLines.length * 17 + 18;
  const bx = B - 18;
  const by = BAR + 10;
  css.push(`@keyframes bubble{0%,${pct(talk, loop)}{opacity:0;transform:translateY(-4px)}${pct(talk + 250, loop)},${pct(talk + 6900, loop)}{opacity:1;transform:translateY(0)}${pct(talk + 7200, loop)},100%{opacity:0;transform:translateY(-4px)}}`);
  css.push(`.bubble{animation:bubble ${loop}ms ease infinite}`);
  const bubble = `
  <g class="bubble">
    <path d="M${bx} ${by}h${cW / 2 + 18 - 8}l8 -9l8 9h${bw - cW / 2 - 18 - 8}v${bh}h-${bw}z" fill="${C.bg}" stroke="${C.fg2}" stroke-width="1.2"/>
    ${bubbleLines.map((l, i) => `<text x="${bx + 13}" y="${by + 22 + i * 17}" font-size="${bFS}" fill="${C.fg}">${esc(l)}</text>`).join("")}
  </g>`;

  const clippy = `
  <g class="cwalk"><g class="cbob">
    <svg x="0" y="${(BAR - cH) / 2 - 1}" width="${cW.toFixed(2)}" height="${cH}" viewBox="0 0 ${sheet.width} ${sheet.height}">
      <g class="cframes"><image href="data:image/png;base64,${png}" width="${sheet.width * sheet.frames}" height="${sheet.height}"/></g>
    </svg>
  </g></g>`;

  const font = (weight) => readFileSync(join(ASSETS, `font-${weight}.woff2`)).toString("base64");
  const title = `costa@github: an Omarchy desktop with fastfetch and journalctl`;
  const desc =
    `An Omarchy desktop. The bar ticks the Command Palette extensions' installs (${installs.map((a) => `${a.name} ${fmt(a.now)}`).join(", ")}) ` +
    `while Clippy walks it and says: "${quote}". cava bounces to the music. fastfetch prints costa@github: Omarchy, Just Eat Takeaway, ${gh.repos} repos, ${gh.stars} stars, ${posts.length} posts. ` +
    `journalctl prints the latest posts (${posts.slice(0, 2).map((p) => p.title).join("; ")}), the latest pushes (${pushes.map((p) => p.repo).join(", ")}), ${fmt(total)} installs, ` +
    `and the Graveyard's ${fmt(graveyard.slaps)} slaps and ${fmt(graveyard.kills)} kills.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<defs>
<style>
@font-face{font-family:JBM;font-weight:400;src:url(data:font/woff2;base64,${font("regular")}) format("woff2")}
@font-face{font-family:JBM;font-weight:700;src:url(data:font/woff2;base64,${font("bold")}) format("woff2")}
text{font-family:JBM,"JetBrains Mono",ui-monospace,monospace;font-size:${FS}px;white-space:pre}
${css.join("\n")}
@media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;animation-delay:0s!important;animation-iteration-count:1!important}.cwalk,.cframes,.cbob,.bubble,.ticker,.tw,.shoot,.sheen,.cv{animation:none!important}.cv{transform:scaleY(.5)}.bubble,.shoot,.cmdcur{opacity:0}.cwalk{transform:translateX(${A}px)}}
</style>
<radialGradient id="glow1" cx="18%" cy="32%" r="60%"><stop offset="0" stop-color="#7156c9"/><stop offset=".55" stop-color="#4a3791" stop-opacity=".6"/><stop offset="1" stop-color="#4a3791" stop-opacity="0"/></radialGradient>
<radialGradient id="glow2" cx="88%" cy="105%" r="55%"><stop offset="0" stop-color="#e27fb5"/><stop offset=".5" stop-color="#b86fb3" stop-opacity=".55"/><stop offset="1" stop-color="#b86fb3" stop-opacity="0"/></radialGradient>
<linearGradient id="logo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.blue}"/><stop offset="1" stop-color="${C.magenta}"/></linearGradient>
<linearGradient id="sheen" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<linearGradient id="cava" gradientUnits="userSpaceOnUse" x1="0" y1="${CAVA.y + CAVA.h}" x2="0" y2="${CAVA.y + 8}"><stop offset="0" stop-color="${C.blue}"/><stop offset=".6" stop-color="${C.magenta}"/><stop offset="1" stop-color="${C.red}"/></linearGradient>
<linearGradient id="trail" x1="0" x2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<clipPath id="tickerclip"><rect x="${tickerX}" y="0" width="${tickerW}" height="${BAR}"/></clipPath>
<linearGradient id="tickerfade" x1="0" x2="1"><stop offset="0" stop-color="${C.bar}"/><stop offset=".06" stop-color="${C.bar}" stop-opacity="0"/><stop offset=".94" stop-color="${C.bar}" stop-opacity="0"/><stop offset="1" stop-color="${C.bar}"/></linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="#2a2161"/>
<rect width="${W}" height="${H}" fill="url(#glow1)"/>
<rect width="${W}" height="${H}" fill="url(#glow2)"/>
<g>${stars.join("")}</g>
<g class="shoot"><line x1="${W - 150}" y1="${BAR + 14}" x2="${W - 60}" y2="${BAR - 26}" stroke="url(#trail)" stroke-width="1.6" stroke-linecap="round"/></g>
<rect width="${W}" height="${BAR}" fill="${C.bar}"/>
${workspaces}
<g clip-path="url(#tickerclip)"><g class="ticker"><text x="${tickerX}" y="${barY}" font-size="13">${tickerText}${tickerText}${tickerText}</text></g></g>
<rect x="${tickerX}" y="0" width="${tickerW}" height="${BAR}" fill="url(#tickerfade)"/>
<circle class="ping" cx="${droidX}" cy="${BAR / 2}" r="9" fill="none" stroke="${C.droid}" stroke-width="1.5"/>
<text class="droid" x="${droidX}" y="${barY + 1}" font-size="16" text-anchor="middle" fill="${C.dim}">\u{F17B}</text>
${tray}
<text x="${clockX}" y="${barY}" font-size="13" text-anchor="end" fill="${C.fg}">${esc(clockText)}</text>
${cava}
${fastfetch}
${journal}
${clippy}
${bubble}
</svg>
`;
}

// ---------------------------------------------------------------- main

const now = new Date();
const [gh, posts, installs, graveyard, pushes, views, quote] = await Promise.all([
  fetchGithub(), fetchPosts(), fetchInstalls(), fetchGraveyard(), fetchPushes(), fetchViews(),
  fetchQuote(Math.floor(now / 86400000)),
]);
const svg = render({ gh, posts, installs, graveyard, pushes, views, quote, now });
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, svg);
console.log(`${OUT}: ${(svg.length / 1024).toFixed(0)} KB`);
