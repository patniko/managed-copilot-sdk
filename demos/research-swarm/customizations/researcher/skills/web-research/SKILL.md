---
name: web-research
description: Search Wikipedia, MDN, Microsoft Learn, GitHub, and arXiv, and read pages as recorded sources with the research command
---
# Web research

The `research` command ships with this environment (`research.py` in this skill, run by Python's standard library).
Every request goes through the sandbox's network rules, so only the allowed reference sites answer.

## Search

```bash
research search "webassembly garbage collection"            # every site, three results each
research search "free-threaded python" --site wikipedia     # one site, five results
```

Sites: `wikipedia`, `mdn`, `learn` (Microsoft Learn), `github` (repositories), and `arxiv` (papers). Each result is a
title, a URL, and a snippet. Results are leads, not sources.

## Read

```bash
research read https://en.wikipedia.org/wiki/WebAssembly
research read https://en.wikipedia.org/wiki/WebAssembly --from 12000   # the next part of a long page
```

`read` prints the page's readable text, 12,000 characters at a time, and records it as a source:

- `research/sources.jsonl` in `/workspace` gets one line per page: its number, URL, title, and when it was read.
- `research/pages/` keeps each page's full text, so reading a page again doesn't fetch it again.

Research Swarm cites only the pages in `research/sources.jsonl`. A page you didn't `read` can't be cited.

## Exit status

- `0`: done.
- `1`: the page failed, or the site is blocked by the sandbox's network rules (the message says which). Use another
  source.
- `2`: wrong arguments.
