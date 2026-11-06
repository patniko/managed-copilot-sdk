#!/usr/bin/env python3
"""Research Swarm's web tool for researchers: search reference sites, read pages, and record every page read.

    research search "<query>" [--site wikipedia|mdn|learn|github|arxiv]
    research read <url> [--from <offset>]
    research sources

`read` appends each page it reads to /workspace/research/sources.jsonl and saves the page's text under
/workspace/research/pages/. Research Swarm cites only pages recorded there. Standard library only: the sandbox's
network rules and proxy settings apply to every request.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ElementTree
from html.parser import HTMLParser
from typing import Iterator, NamedTuple

WORKSPACE = "/workspace"
ROOT = os.path.join(WORKSPACE, "research")
LOG = os.path.join(ROOT, "sources.jsonl")
PAGES = os.path.join(ROOT, "pages")
AGENT = "ResearchSwarm/1.0 (Managed Copilot demo)"
TIMEOUT = 25
MAX_BYTES = 4_000_000
SHOW = 12_000


class Blocked(Exception):
    """The sandbox's network rules refused a host."""


class FetchFailed(Exception):
    """A page or API answered with an error, or didn't answer."""


class Result(NamedTuple):
    title: str
    url: str
    snippet: str


class _Redirects(urllib.request.HTTPRedirectHandler):
    """Remembers the last URL requested, so a blocked redirect names the host that was refused."""

    last = ""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802 (urllib's name)
        _Redirects.last = newurl
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_Redirects)


def _host(url: str) -> str:
    return (urllib.parse.urlsplit(url).hostname or url).lower()


def _https(url: str) -> str:
    url = url.strip()
    if not re.match(r"^[a-z][a-z0-9+.-]*://", url, re.I):
        url = "https://" + url
    if url.lower().startswith("http://"):
        url = "https://" + url[7:]
    return urllib.parse.urldefrag(url)[0]


def fetch(url: str, accept: str) -> tuple[str, str, bytes]:
    """Returns the final URL, the content type, and the body."""
    _Redirects.last = url
    request = urllib.request.Request(url, headers={"User-Agent": AGENT, "Accept": accept, "Accept-Language": "en"})
    try:
        with _OPENER.open(request, timeout=TIMEOUT) as response:
            return response.geturl(), response.headers.get("Content-Type", ""), response.read(MAX_BYTES)
    except urllib.error.HTTPError as error:
        raise FetchFailed(f"{_host(_Redirects.last)} answered {error.code} {error.reason}") from None
    except urllib.error.URLError as error:
        reason = str(error.reason)
        if "Tunnel connection failed" in reason and "403" in reason:
            raise Blocked(_host(_Redirects.last)) from None
        raise FetchFailed(f"{_host(_Redirects.last)}: {reason}") from None
    except (TimeoutError, OSError) as error:
        raise FetchFailed(f"{_host(_Redirects.last)}: {error}") from None


def _decode(content_type: str, body: bytes) -> str:
    match = re.search(r"charset=([\w-]+)", content_type, re.I)
    try:
        return body.decode(match.group(1) if match else "utf-8", errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


def get_json(url: str, accept: str = "application/json") -> dict:
    _, content_type, body = fetch(url, accept)
    return json.loads(_decode(content_type, body))


# ─── Page text ───────────────────────────────────────────────────────────────────────────────────────────────

SKIP = {"script", "style", "noscript", "svg", "template", "nav", "header", "footer", "aside", "form", "button", "select", "iframe", "canvas", "math"}
# Wikipedia's navigation boxes, edit links, and maintenance banners.
SKIP_CLASSES = {"navbox", "mw-editsection", "noprint", "metadata", "mw-jump-link"}
BLOCK = {"p", "div", "section", "article", "main", "li", "ul", "ol", "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "dd", "dt", "dl", "figcaption"}
VOID = {"br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"}


class _Text(HTMLParser):
    """Readable text of a page: its <main> or <article> when it has one, else its body, without navigation."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.og_title = ""
        self._in_title = False
        self._skip = 0
        self._main = 0
        self._open: list[tuple[str, bool, bool]] = []
        self.everything: list[str] = []
        self.main: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "meta" and values.get("property") == "og:title":
            self.og_title = values.get("content") or ""
        # Only the document's own title: icons carry <title> elements too.
        if tag == "title" and not self.title:
            self._in_title = True
        if tag in VOID:
            if tag in ("br", "hr"):
                self._emit("\n")
            return
        skipped = tag in SKIP or not SKIP_CLASSES.isdisjoint((values.get("class") or "").split())
        main = tag in ("main", "article") or values.get("role") == "main"
        self._open.append((tag, skipped, main))
        self._skip += skipped
        self._main += main
        if tag in BLOCK:
            self._emit("\n")
        if tag in ("h1", "h2", "h3", "h4"):
            self._emit("#" * int(tag[1]) + " ")
        elif tag == "li":
            self._emit("- ")
        elif tag in ("td", "th"):
            self._emit(" | ")

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        for index in range(len(self._open) - 1, -1, -1):
            if self._open[index][0] == tag:
                for _, skipped, main in self._open[index:]:
                    self._skip -= skipped
                    self._main -= main
                del self._open[index:]
                break
        if tag in BLOCK:
            self._emit("\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        else:
            self._emit(data)

    def _emit(self, text: str) -> None:
        if self._skip:
            return
        self.everything.append(text)
        if self._main:
            self.main.append(text)


def _tidy(text: str) -> str:
    lines: list[str] = []
    for line in text.split("\n"):
        line = re.sub(r"\[edit\]", "", re.sub(r"[ \t\r\f\v\u00a0]+", " ", line)).strip()
        if re.fullmatch(r"#+|-|[|\s]*", line):
            if lines and lines[-1]:
                lines.append("")
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def page_text(url: str, content_type: str, body: bytes) -> tuple[str, str]:
    """The page's title and readable text."""
    text = _decode(content_type, body)
    kind = content_type.split(";")[0].strip().lower()
    fallback = urllib.parse.unquote(urllib.parse.urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]) or _host(url)
    if "html" in kind or (not kind and "<html" in text[:2000].lower()):
        parser = _Text()
        parser.feed(text)
        parser.close()
        title = " ".join((parser.title or parser.og_title).split())
        content = _tidy("".join(parser.main if len("".join(parser.main).strip()) > 200 else parser.everything))
        return title or fallback, content
    if "json" in kind:
        try:
            return fallback, json.dumps(json.loads(text), indent=2, ensure_ascii=False)
        except ValueError:
            pass
    return fallback, text.strip()


# ─── Sources ─────────────────────────────────────────────────────────────────────────────────────────────────


def sources() -> list[dict]:
    if not os.path.exists(LOG):
        return []
    entries = []
    with open(LOG, encoding="utf-8") as handle:
        for line in handle:
            try:
                entries.append(json.loads(line))
            except ValueError:
                continue
    return entries


def record(url: str, requested: str, content_type: str, title: str, text: str) -> dict:
    os.makedirs(PAGES, exist_ok=True)
    number = len(sources()) + 1
    path = os.path.join(PAGES, f"{number:02d}-{re.sub(r'[^a-z0-9.-]+', '-', _host(url))}.txt")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    entry = {
        "n": number,
        "url": url,
        **({"requested": requested} if requested != url else {}),
        "title": title,
        "type": content_type.split(";")[0].strip(),
        "chars": len(text),
        "file": os.path.relpath(path, WORKSPACE),
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def read(url: str, start: int) -> int:
    url = _https(url)
    known = next((entry for entry in sources() if url in (entry.get("url"), entry.get("requested"))), None)
    if known:
        with open(os.path.join(WORKSPACE, known["file"]), encoding="utf-8") as handle:
            text = handle.read()
        entry = known
        print(f"Source {entry['n']} (read before): {entry['title']}")
    else:
        try:
            final, content_type, body = fetch(url, "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5")
        except Blocked as blocked:
            print(f"Blocked: {blocked} isn't one of the sites this sandbox may read. Use another source.", file=sys.stderr)
            return 1
        except FetchFailed as failed:
            print(f"Couldn't read {url}: {failed}", file=sys.stderr)
            return 1
        title, text = page_text(final, content_type, body)
        if not text:
            print(f"{url} has no readable text.", file=sys.stderr)
            return 1
        entry = record(urllib.parse.urldefrag(final)[0], url, content_type, title, text)
        print(f"Source {entry['n']} recorded: {title}")
    print(f"URL: {entry['url']}")
    end = min(len(text), max(0, start) + SHOW)
    print(f"Saved: {entry['file']} ({len(text):,} characters)\n")
    print(text[max(0, start):end])
    if end < len(text):
        print(f"\n[{len(text) - end:,} more characters: research read {entry['url']} --from {end}]")
    return 0


# ─── Search ──────────────────────────────────────────────────────────────────────────────────────────────────


def _plain(snippet: str) -> str:
    return " ".join(re.sub(r"<[^>]+>", "", snippet).replace("&quot;", '"').replace("&amp;", "&").split())


def search_wikipedia(query: str, limit: int) -> Iterator[Result]:
    params = {"action": "query", "list": "search", "srsearch": query, "format": "json", "srlimit": limit, "utf8": 1}
    for item in get_json("https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode(params))["query"]["search"]:
        yield Result(item["title"], "https://en.wikipedia.org/wiki/" + urllib.parse.quote(item["title"].replace(" ", "_")), _plain(item.get("snippet", "")))


def search_mdn(query: str, limit: int) -> Iterator[Result]:
    params = {"q": query, "locale": "en-US", "size": limit}
    for doc in get_json("https://developer.mozilla.org/api/v1/search?" + urllib.parse.urlencode(params))["documents"][:limit]:
        yield Result(doc["title"], "https://developer.mozilla.org" + doc["mdn_url"], _plain(doc.get("summary", "")))


def search_learn(query: str, limit: int) -> Iterator[Result]:
    params = {"search": query, "locale": "en-us", "$top": limit}
    for item in get_json("https://learn.microsoft.com/api/search?" + urllib.parse.urlencode(params))["results"][:limit]:
        yield Result(item["title"], item["url"], _plain(item.get("description", "")))


def search_github(query: str, limit: int) -> Iterator[Result]:
    params = {"q": query, "per_page": limit}
    data = get_json("https://api.github.com/search/repositories?" + urllib.parse.urlencode(params), "application/vnd.github+json")
    for repo in data["items"][:limit]:
        yield Result(repo["full_name"], repo["html_url"], _plain(repo.get("description") or ""))


def search_arxiv(query: str, limit: int) -> Iterator[Result]:
    words = re.findall(r"[\w-]+", query)[:6]
    params = {"search_query": " AND ".join(f"all:{word}" for word in words), "max_results": limit}
    _, content_type, body = fetch("https://export.arxiv.org/api/query?" + urllib.parse.urlencode(params), "application/atom+xml")
    atom = {"a": "http://www.w3.org/2005/Atom"}
    for entry in ElementTree.fromstring(_decode(content_type, body)).findall("a:entry", atom):
        link = (entry.findtext("a:id", "", atom) or "").replace("http://", "https://")
        yield Result(" ".join((entry.findtext("a:title", "", atom) or "").split()), link, _plain(entry.findtext("a:summary", "", atom) or ""))


SITES = {
    "wikipedia": ("Wikipedia", search_wikipedia),
    "mdn": ("MDN Web Docs", search_mdn),
    "learn": ("Microsoft Learn", search_learn),
    "github": ("GitHub", search_github),
    "arxiv": ("arXiv", search_arxiv),
}


def search(query: str, site: str | None) -> int:
    chosen = [site] if site else list(SITES)
    limit = 5 if site else 3

    def run(key: str) -> tuple[str, list[Result] | str]:
        try:
            return key, list(SITES[key][1](query, limit))
        except Blocked as blocked:
            return key, f"blocked ({blocked} isn't allowed)"
        except (FetchFailed, ValueError, KeyError, ElementTree.ParseError) as error:
            return key, f"failed ({error})"

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(chosen)) as pool:
        answers = dict(pool.map(run, chosen))
    found = 0
    for key in chosen:
        name, answer = SITES[key][0], answers[key]
        if isinstance(answer, str):
            print(f"{name}: {answer}\n")
            continue
        print(f"{name}{'' if answer else ': no results'}")
        for index, result in enumerate(answer, 1):
            found += 1
            print(f"  {index}. {result.title}\n     {result.url}")
            if result.snippet:
                print(f"     {result.snippet[:200]}")
        print()
    print("Search results are leads, not sources: read a page with `research read <url>` before you use it.")
    return 0 if found else 1


def main(argv: list[str]) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(prog="research", description="Search reference sites and read pages, recording each page read as a source.")
    commands = parser.add_subparsers(dest="command", required=True)
    find = commands.add_parser("search", help="search the reference sites (results are leads, not sources)")
    find.add_argument("query")
    find.add_argument("--site", choices=sorted(SITES))
    page = commands.add_parser("read", help="read a page and record it as a source")
    page.add_argument("url")
    page.add_argument("--from", dest="start", type=int, default=0, help="character offset to continue from")
    commands.add_parser("sources", help="list the pages you've read")
    args = parser.parse_args(argv)
    if args.command == "search":
        return search(args.query, args.site)
    if args.command == "read":
        return read(args.url, args.start)
    entries = sources()
    if not entries:
        print("No sources yet: read a page with `research read <url>`.")
    for entry in entries:
        print(f"{entry['n']}. {entry['title']}\n   {entry['url']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
