# Side App fixtures

Real workspace files the Side App regression tests copy into a temporary working
root before exercising the host. Tests never open these files in place, so a test
can rewrite its own copies freely.

- `canvas-basic/`: an interactive HTML draft with same-directory CSS, JS, a nested
  script and a real PNG. It proves relative assets load under the ticketed route and
  that asset bytes participate in the preview revision.
- `canvas-sensitive/`: allowed assets beside names that must never be served —
  credential-shaped files and a symlink/junction target outside the entry directory.
  The dotfile and PEM-shaped honey files are written by the test itself: the leak
  scanner refuses `.env`/`.pem` names anywhere in the repository, fixture or not.
- `reader-long/`: one long Markdown article with repeated passages and a local
  image, one MDX file that must render as plain Markdown, one `.markdown` alias and
  one `.txt` file the Reader refuses. The repeated passages pin down the rule that a
  selection instruction only carries line numbers when the quoted text is unique.
