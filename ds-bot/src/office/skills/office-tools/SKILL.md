---
name: office-tools
description: Inspect, check, and edit .docx/.pptx/.xlsx packages in place — block-level reading, comments, tracked changes, slide inventory and layout checks, slide reorder/duplicate/cleanup, workbook errors, package checks, contact sheets. Works offline; nothing to install.
---

# Office tools

A bundled command line for the jobs the format skills cannot do safely: reading a document's structure with stable ids, repairing packages, targeted edits, tracked changes, layout findings, and contact sheets of rendered pages. Run every command through the Node and CLI paths in the runtime block at the end of this skill.

Every command accepts `--json` and prints `{"ok":true,"data":…}` for a run that completed, or `{"ok":false,"error":{"code","message"}}` when it failed. Findings are results, not failures: they land inside `data.findings` with `ok` still true, and the exit code carries them — 0 = ok, 1 = findings remain, 2 = usage or failure. Edits write a new file (`-o out`) or overwrite the input (`--in-place`); they never touch the input otherwise.

## Commands

- `unpack <file> <dir>` / `pack <dir> <file>` — extract a package to readable XML and repack it. `pack --against <original>` also runs `check` against the original.
- `check <file|dir> [--against <original>] [--fix]` — only defects that make Office refuse a file or show a repair prompt. `--against` reports just the issues the original lacks. `--fix` repairs what is safe (xml:space, duplicate ids, content-type rows, dangling relationships).
- `docx read <file> [--changes]` — body blocks as `p1…`, `t1…` in reading order, with paragraph style, tables as cell rows (merges noted), headers/footers, footnotes/endnotes, comments and the paragraph each anchors to. Text shows tracked changes accepted; `--changes` marks them inline (`{+inserted (Ana)+}`, `{-deleted (Ana)-}`, moves, format changes, deleted paragraph marks).
- `docx fields <file>` — simple and complex fields with instruction and current result.
- `docx edit <file> (-o out|--in-place) --ops <json|@file>` — one batch of ops, all-or-nothing, ids from `docx read` of the same file: `replace` (cross-run text/regex, keeps formatting), `set_cell`, `set_field`, `insert`, `delete`, `comment`, `accept_changes`, `reject_changes`.
- `pptx inventory <file> [--slides N…]` — slide size, theme fonts, and every shape per slide: id, name, kind, placeholder, resolved box in inches (group transforms applied, layout/master placeholder inherited), text with run fonts and sizes, picture media.
- `pptx layout <file> [--autofit]` — overlapping text boxes and shapes off the slide, from the same resolved boxes. `--autofit` sets `a:normAutofit` on the shapes found. Overflow inside a box still needs a render.
- `pptx slides <file> -o|--in-place --order 3,1,1,5` — reorder by current positions; a repeated position duplicates the slide (notes, charts and embedded workbooks copied); positions left out are removed.
- `pptx clean <file|dir> [--dry-run]` — drop slides not in the list, unreachable parts, dangling relationships/Overrides, unreferenced media (also works on docx/xlsx).
- `xlsx inventory <file>` — sheets (state, dimension, cell/formula counts, merges, tables, charts), defined names, every error cell with its formula, and a note when formulas have no cached value.
- `xlsx read <file> --sheet <name> [--range A1:H40]` — a grid of cached values with formulas shown; dates as ISO.
- `sheet <png…|dir> -o <contact.png> [--cols 4] [--width 320]` — one contact sheet of rendered pages, labelled with page numbers.

## Workflows

**Word** — `docx read` for the ids → one `docx edit` batch over the opened document → `docx read` again to confirm → `check --against <the untouched original>` for anything left. Keep the original copy untouched (no `--in-place` on it).

**PowerPoint** — `pptx inventory` → edit (python-pptx through the format skill; `pptx slides`/`pptx clean` for structure) → `pptx layout` for overlap/off-slide findings → when `office-render` is in the catalog, render → `sheet` over the rendered images and look at the contact sheet before single slides → fix → recheck.

**Excel** — `xlsx inventory` → edit with openpyxl (format skill) → `office-recalculate` → `xlsx inventory` again and confirm no error cells and no uncached formulas.

**XML edits** — only through `unpack`, a real XML parser, and `pack --against`. Never sed or string-splice XML.

**Finish line** — `check` passes clean, `pptx layout` findings addressed or explained, the contact sheet looked at when rendering is available, and anything that could not be verified is said in the report.

## Design rules for a new deck

One idea and one visual per slide. Titles state the point. One accent colour. A locked type scale. No card behind every paragraph. Draw the relation the text names.
