---
name: office
description: Create, edit, inspect, or convert Office documents, spreadsheets, presentations, and PDFs. Also how to read a PDF, scanned or not, that the user sent, since the read tool opens text files only. Load before rendering, conversion, or recalculation to choose the relevant workflow and enable Office tools on the next step.
---

# Office task routing

Call the `skill` tool with the format skill name before creating, reading, or editing Office files. Loading `office` or a format skill enables `office_render`, `office_convert`, and `office_recalculate` on the next step when the host serves those tools; standalone rendering, PDF export, and recalculation need no format skill.

- Create, read, or edit: `office-docx` (Word), `office-pptx` (PowerPoint), or `office-xlsx` (Excel).
- Inspect package structure, check package health, or edit content in place — `office-tools`, used together with the format skill: block-level docx reading, comments, tracked changes accept/reject, pptx inventory, layout checks, slide reorder/duplicate/cleanup, xlsx inventory, package checks, contact sheets.
- Images, visual inspection, or tasks primarily about layout, spacing, sizing, or alignment: call `office_render` once it is in your tools (or load `office-render` when that skill is in the catalog), even without an explicit visual-check request.
- Read a PDF, scanned or not, such as a file the user attached (`read` fails on it with "binary file"): call `office_render` with `input` set to the PDF's path and `pages` set to the pages you need once it is in your tools (or load `office-render` when that skill is in the catalog), then read the page images. Take a few pages per call, say which pages you read when the document is longer, and raise `dpi` for small print. This needs a model that accepts images. If yours does not, or rendering is unavailable here, say that and ask the user for the text or for page images; never stop at "cannot read it".
- Refresh spreadsheet formula results: call `office_recalculate` with `format: "xlsx"` or `"ods"` once it is in your tools (or load `office-recalculate` when that skill is in the catalog).
- Export or convert an Office file (Office inputs only, not PDFs): call `office_convert` with `format` once it is in your tools and copy its temporary output to the destination (for PDF export alone, check the copy is nonempty and starts with `%PDF-`, then deliver it without rendering), or load `office-export-pdf` when that skill is in the catalog.

Honor requests to skip rendering. New files, content edits, formulas, and incidental formatting such as bold headers or number formats need no render unless visual inspection is requested. Reuse loaded skills and do not reload them.

Skills and tools not present in the catalog or tool list are unavailable in this environment.
