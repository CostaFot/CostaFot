#!/usr/bin/env node
// Build the static assets the hero embeds: a subset of JetBrainsMono Nerd Font
// and a strip of Clippy's sprite frames. Run by hand (it needs uvx and
// ImageMagick) when the glyphs or animations the hero uses change; the output
// in assets/hero/ is committed so the daily workflow only needs Node.
//
//   node scripts/hero-assets.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Clippy is about 50 px tall on the profile; three quarters of the sheet's
// 124x93 cells is still sharp on a HiDPI screen and half the bytes.
const CELL = [93, 70];
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "hero");
const CLIPPY = "https://raw.githubusercontent.com/CostaFot/omarchy-inappropriate-clippy/main/assets/clippy/";
const FONTS = "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-";
// The animations the hero plays, in clippy.js's names.
const ANIMATIONS = ["RestPose", "Wave", "GetAttention", "Explain"];
// ASCII, Latin-1, dashes and quotes, arrows, the box and block pieces, a few
// shapes, and the Nerd Font icons the bar uses (android, arch, bluetooth,
// wifi, volume, battery, cpu, star).
const UNICODES = [
  "U+0020-007E", "U+00A0-00FF", "U+2010-2027", "U+2032-2033", "U+2190-2193",
  "U+2500-2503", "U+250C-2524", "U+256D-2570", "U+2580-2590", "U+25A0", "U+25B2",
  "U+25BC", "U+25CF", "U+2605", "U+276F",
  "U+F17B", "U+F303", "U+F00AF", "U+F0928", "U+F057E", "U+F0079", "U+F035B",
].join(",");

for (const weight of ["Regular", "Bold"]) {
  execFileSync("uvx", [
    "--quiet", "--from", "fonttools", "--with", "brotli", "pyftsubset", `${FONTS}${weight}.ttf`,
    `--unicodes=${UNICODES}`, "--flavor=woff2", "--layout-features=", "--no-hinting",
    "--desubroutinize", `--output-file=${join(OUT, `font-${weight.toLowerCase()}.woff2`)}`,
  ], { stdio: ["ignore", "ignore", "inherit"] });
}

const agent = await (await fetch(CLIPPY + "agent.json")).json();
const [w, h] = agent.framesize;
const tmp = mkdtempSync(join(tmpdir(), "clippy-"));
try {
  const map = join(tmp, "map.png");
  writeFileSync(map, Buffer.from(await (await fetch(CLIPPY + "map.png")).arrayBuffer()));
  // One cell per distinct sprite position; animations index into the strip.
  const cells = [];
  const index = new Map();
  const animations = {};
  for (const name of ANIMATIONS) {
    animations[name] = agent.animations[name].frames
      .filter((f) => f.images?.length)
      .map((f) => {
        const [x, y] = f.images[0];
        const key = `${x},${y}`;
        if (!index.has(key)) {
          index.set(key, cells.length);
          cells.push([x, y]);
        }
        return [index.get(key), f.duration];
      });
  }
  execFileSync("magick", [
    ...cells.flatMap(([x, y]) => ["(", map, "-crop", `${w}x${h}+${x}+${y}`, "+repage", "-resize", `${CELL[0]}x${CELL[1]}!`, ")"]),
    "+append", "-strip", "-colors", "96", `PNG8:${join(OUT, "clippy.png")}`,
  ]);
  writeFileSync(join(OUT, "clippy.json"), JSON.stringify({ width: CELL[0], height: CELL[1], frames: cells.length, animations }) + "\n");
  console.log(`clippy.png: ${cells.length} frames`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
