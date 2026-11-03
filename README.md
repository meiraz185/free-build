# FREE BUILD

A click-only 3D brick sandbox. Pick a brick, pick a colour, click to build — anything you like. No levels, no goals, no right answers.

Every action is a mouse click: no dragging, no keyboard, no typing.

## Run it locally

The page uses JavaScript modules, so it has to be served over HTTP (opening `index.html` straight from the file system won't work). From this folder, run either:

```bash
python3 -m http.server 8000
# or
npx serve .
```

Then open http://localhost:8000.

Three.js is bundled in `lib/`, so the game works offline. Only the two web fonts load from Google Fonts, and the page falls back to system fonts if they can't load.

## Deploy to GitHub Pages

1. Create a new GitHub repository and upload everything in this folder (keep the folder structure, including `lib/` and `.nojekyll`).
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/ (root)`, and save.
4. After a minute the game is live at `https://<your-username>.github.io/<repo-name>/`.

No build step is needed.

## How to play

| Action | How |
|---|---|
| Choose a brick | Click 1×1, 1×2, 2×2 or 2×4 in the sidebar |
| Choose a colour | Click one of the six swatches |
| Preview | Move the mouse over the baseplate: a see-through brick shows where it will go (red = not allowed) |
| Place | Click |
| Stack | Point at the top of a brick and click |
| Rotate | Click **Rotate** (90° each time) |
| Select a brick | Click **Select**, then click a brick |
| Delete | Select a brick, then click **Delete** |
| Undo | Click **Undo** (works for placing, deleting and Reset) |
| Clear everything | Click **Reset** (Undo brings it back) |
| Camera | Round buttons bottom-right: rotate left/right, zoom in/out |
| Show off | Click **Finish** for a slow orbit of your creation |

On touch screens, tap once to preview and tap the same spot again to place.

## Building rules

- Bricks snap to the 16×16 stud grid and to whole brick-height layers.
- A brick can't overlap another brick.
- A brick above the baseplate needs at least one stud of support directly underneath it — no floating bricks.
- Bricks are kept on the baseplate (the preview slides back inside the edge).
- A brick that is holding something up can't be deleted until the bricks on top are removed.

## Files

```
index.html    page structure and controls
style.css     interface styling, responsive layout
main.js       scene, brick geometry, placement rules, undo, camera, sounds, finish mode
lib/          Three.js r170 (MIT licence) and three add-ons used
```

All brick geometry is generated in code and all sounds are synthesised with the Web Audio API, so there are no model or audio files.
