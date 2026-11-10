---
name: spreadsheets
description: Read, filter, and create Excel (.xlsx) spreadsheets. Use whenever a task involves an .xlsx file.
---

Use `xlsx.py` in this skill's folder instead of writing your own spreadsheet code. It needs `python3` with `openpyxl` (`pip install --user openpyxl` if it is missing).

Read rows as JSON lines. Each line has the row number and the row's non-empty cells:

```bash
python3 <skill folder>/xlsx.py read data.xlsx                                         # every row
python3 <skill folder>/xlsx.py read data.xlsx --match "City=Seattle|New York" --nonempty Notes
python3 <skill folder>/xlsx.py read data.xlsx --match "City=Seattle|New York" --values Notes
```

`--match` keeps rows whose column is like one of the `|`-separated values. It ignores case, accents, punctuation, and
small typos, so check the matched rows yourself. `--values` prints a column's distinct values with their row counts
instead of the rows. A count of rows goes to stderr.

To filter on a free-text column, list its distinct values with `--values`, decide yourself which ones fit by reading
them (don't write keyword lists or regexes), then pass those values to `--match` to get the rows.

To make a new spreadsheet from some of the rows, copy them with the header:

```bash
python3 <skill folder>/xlsx.py write data.xlsx result.xlsx --rows 12,57,301
```
