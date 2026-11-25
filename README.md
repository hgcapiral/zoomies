# Zoomies

A desktop reader for comics and manga (`.cbz`, `.cbr`) that zooms in on what you're reading: a
magnifying lens, one panel at a time, or one speech bubble at a time.

## Features

- **Lens** (L): a magnifier that follows the mouse.
- **Panel View** (P): pops out an enlarged copy of each panel, with its bubbles, over its spot on
  the page.
- **Bubble View** (B): pops out each speech bubble or caption, cut to its shape, in reading order.
- ←/→ or clicking the left or right half steps through panels or bubbles, then turns the page.
  Press P or B again, or Esc, to go back to the lens.
- **Manga mode** reads right to left, with an option for ← to go forward. The **Panel detector**
  setting picks the comic rules or the trained manga model, separately from the reading direction.
- The whole comic is detected in the background, starting with the page on screen.
- Recently Read bookmarks remember your page in each comic. Colour themes in the settings.

## Running it

```sh
npm install
npm run dev
```

This starts Vite on port 5173 and then the Electron window. There's no packaged build yet.

## Detection models

Panels and bubbles are found on your computer with two ONNX models (run with `onnxruntime-web`) and
rule-based fallbacks. The models, their sources and their licences are listed in
[`public/models/README.md`](public/models/README.md). The manga panel model is AGPL-3.0, so
distributing the app with it means releasing its source under AGPL-3.0 as well.

`tools/` has the regression and model-trial scripts used to test detection changes.
