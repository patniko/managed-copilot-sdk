#!/usr/bin/env python3
"""Reads rows from an .xlsx sheet as JSON lines, and copies chosen rows into a new .xlsx. See SKILL.md."""
import argparse
import difflib
import json
import sys
import unicodedata

import openpyxl


def normalize(value):
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode().lower()
    return " ".join("".join(c if c.isalnum() else " " for c in text).split())


def like(value, wanted, cutoff):
    text = normalize(value)
    return bool(text) and any(difflib.SequenceMatcher(None, text, w).ratio() >= cutoff for w in wanted)


def read(args):
    rows = openpyxl.load_workbook(args.file, read_only=True, data_only=True).active.iter_rows(values_only=True)
    header = [str(name) for name in next(rows)]
    matches = [(column, [normalize(v) for v in values.split("|")]) for column, values in (m.split("=", 1) for m in args.match)]
    total = shown = 0
    distinct = {}
    for number, values in enumerate(rows, start=2):
        total += 1
        record = dict(zip(header, values))
        if any(str(record.get(column) or "").strip() == "" for column in args.nonempty):
            continue
        if any(not like(record.get(column), wanted, args.cutoff) for column, wanted in matches):
            continue
        shown += 1
        if args.values:
            value = str(record.get(args.values) or "").strip()
            distinct.setdefault(normalize(value), [value, 0])[1] += 1
            continue
        print(json.dumps({"row": number, **{k: v for k, v in record.items() if v not in (None, "")}}, ensure_ascii=False, default=str))
    for value, count in sorted(distinct.values(), key=lambda item: -item[1]):
        print(f"{count}\t{value}")
    print(f"{shown} of {total} rows", file=sys.stderr)


def write(args):
    numbers = [int(n) for n in args.rows.replace(",", " ").split()]
    source = openpyxl.load_workbook(args.file, data_only=True).active
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = source.title
    for number in [1, *numbers]:
        sheet.append([cell.value for cell in source[number]])
    book.save(args.out)
    print(f"Wrote {len(numbers)} rows to {args.out}")


parser = argparse.ArgumentParser(description=__doc__)
commands = parser.add_subparsers(required=True)
reader = commands.add_parser("read", help="print rows as JSON lines, with their row numbers")
reader.add_argument("file")
reader.add_argument("--match", action="append", default=[], metavar="COLUMN=V1|V2", help="keep rows whose column is like one of the values (ignores case, accents, punctuation, small typos)")
reader.add_argument("--nonempty", action="append", default=[], metavar="COLUMN", help="keep rows where the column has a value")
reader.add_argument("--values", metavar="COLUMN", help="instead of rows, print the column's distinct values with how many rows have each")
reader.add_argument("--cutoff", type=float, default=0.8, help="how similar a --match value must be, 0-1 (default 0.8)")
reader.set_defaults(run=read)
writer = commands.add_parser("write", help="copy the header and the given rows into a new .xlsx")
writer.add_argument("file")
writer.add_argument("out")
writer.add_argument("--rows", required=True, help="row numbers from read, separated by commas or spaces")
writer.set_defaults(run=write)
args = parser.parse_args()
args.run(args)
