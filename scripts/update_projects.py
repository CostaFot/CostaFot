#!/usr/bin/env python3
"""Render the Projects section of README.md from the site's projects page.

The source of truth is the front matter of src/content/pages/projects.md in
CostaFot/costafotiadis.com: groups of projects with a title, blurb, preview
image and links. This script fetches it, renders a card grid, and replaces
whatever sits between the PROJECTS markers in README.md. The daily workflow
runs it and commits when the output changed.
"""

import html
import re
import sys
import urllib.request
from pathlib import Path

import yaml

SITE_REPO = "CostaFot/costafotiadis.com"
SITE_URL = "https://www.costafotiadis.com"
SOURCE = f"https://raw.githubusercontent.com/{SITE_REPO}/main/src/content/pages/projects.md"
IMAGES = f"https://raw.githubusercontent.com/{SITE_REPO}/main/src/images/"
README = Path(__file__).resolve().parent.parent / "README.md"
START = "<!-- PROJECTS:START -->"
END = "<!-- PROJECTS:END -->"
COLUMNS = 3


def fetch(url: str) -> str:
    with urllib.request.urlopen(url, timeout=30) as resp:
        return resp.read().decode("utf-8")


def front_matter(text: str) -> dict:
    match = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not match:
        sys.exit("projects.md has no front matter")
    # The site's YAML parser accepts `href: https://x/y?id=z }` inside a flow
    # mapping; PyYAML does not (`?` is an indicator). Quote those values.
    text = re.sub(r'(href:\s*)([^\s"\'}][^}]*?)\s*}', r'\1"\2" }', match.group(1))
    return yaml.safe_load(text)


def absolute(href: str) -> str:
    return SITE_URL + href if href.startswith("/") else href


def image_url(path: str) -> str:
    return IMAGES + path.split("images/", 1)[1]


def first_sentence(blurb: str) -> str:
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", blurb)  # markdown links
    text = text.replace("`", "")
    match = re.match(r"(.+?[.!?])(\s|$)", text)
    return (match.group(1) if match else text).strip()


def links_html(links: list[dict]) -> str:
    return " · ".join(
        f'<a href="{html.escape(absolute(link["href"]))}">{html.escape(link["label"])}</a>'
        for link in links
    )


def card(project: dict) -> str:
    title = html.escape(project["title"])
    links = project.get("links", [])
    primary = html.escape(absolute(links[0]["href"])) if links else SITE_URL + "/projects/"
    alt = html.escape(project.get("alt", project["title"]))
    blurb = html.escape(first_sentence(project.get("blurb", "")))
    return (
        f'<td width="{100 // COLUMNS}%" valign="top">'
        f'<a href="{primary}"><img src="{image_url(project["image"])}" alt="{alt}" width="100%"></a>'
        f"<br><b>{title}</b><br><sub>{blurb}</sub>"
        + (f"<br><sub>{links_html(links)}</sub>" if links else "")
        + "</td>"
    )


def text_entry(project: dict) -> str:
    links = project.get("links", [])
    return f"<b>{html.escape(project['title'])}</b>" + (
        f" ({links_html(links)})" if links else ""
    )


def render_group(group: dict) -> str:
    heading = html.escape(group["name"])
    if group.get("note"):
        heading += f" <sub>{html.escape(group['note'])}</sub>"
    with_image = [p for p in group["projects"] if p.get("image")]
    without = [p for p in group["projects"] if not p.get("image")]

    out = [f"<h4>{heading}</h4>"]
    if with_image:
        rows = [with_image[i : i + COLUMNS] for i in range(0, len(with_image), COLUMNS)]
        out.append("<table>")
        for row in rows:
            # Pad short rows so the columns keep their width; a lone card
            # would otherwise stretch to the full table width.
            cells = [card(p) for p in row]
            cells += [f'<td width="{100 // COLUMNS}%"></td>'] * (COLUMNS - len(cells))
            out.append("<tr>" + "".join(cells) + "</tr>")
        out.append("</table>")
    if without:
        out.append("<p>Also: " + ", ".join(text_entry(p) for p in without) + "</p>")
    return "\n".join(out)


def render(groups: list[dict]) -> str:
    return "\n\n".join(render_group(g) for g in groups)


def main() -> int:
    data = front_matter(fetch(SOURCE))
    section = render(data["groups"])

    readme = README.read_text()
    if START not in readme or END not in readme:
        sys.exit(f"README.md is missing the {START} / {END} markers")
    head, rest = readme.split(START, 1)
    _, tail = rest.split(END, 1)
    updated = f"{head}{START}\n{section}\n{END}{tail}"

    if updated != readme:
        README.write_text(updated)
        print("README.md updated")
    else:
        print("README.md unchanged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
