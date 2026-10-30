---
name: office
description: Create, edit, inspect, or convert Office documents, spreadsheets, presentations, and PDFs. Load to choose the relevant workflow.
---

# Office task routing

Call the `skill` tool with the format skill name before creating, reading, or editing Office files. Standalone rendering, PDF export, and recalculation need only their operation skill.

- Create, read, or edit: `office-docx` (Word), `office-pptx` (PowerPoint), or `office-xlsx` (Excel).
- Inspect package structure, check package health, or edit content in place — `office-tools`, used together with the format skill: block-level docx reading, comments, tracked changes accept/reject, pptx inventory, layout checks, slide reorder/duplicate/cleanup, xlsx inventory, package checks, contact sheets.
- Images, visual inspection, or tasks primarily about layout, spacing, sizing, or alignment: `office-render`, even without an explicit visual-check request.
- Refresh spreadsheet formula results: `office-recalculate`.
- Export an Office file to PDF: `office-export-pdf`.

Honor requests to skip rendering. New files, content edits, formulas, and incidental formatting such as bold headers or number formats need no render unless visual inspection is requested. Do not reload skills.

Skills not present in the catalog are unavailable in this environment.
