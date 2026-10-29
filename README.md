# Digital-Matter-01-Bouncy-Ball

A projector shows bouncing balls on a wall, a webcam tracks pink sticky notes, and the balls bounce off them.

## Pages

| Page | URL | What |
|---|---|---|
| `index.html` | `/` | Sandbox: the plain bouncy ball (the foundation) |
| `game.html` | `/game` | Cup game: 5 levels, 10 balls per round |

Every page shares one foundation in `core/`. Calibration and tuner settings are saved
in `localStorage`, so you calibrate once and every page uses it.

```
core/
  core.js            start({ project }): camera, notes, physics, panel, draw loop
  core.css
  note_detector.js   calibration.js   opencv.js   matter.min.js
projects/
  cup-game.js        the cup game's rules and drawing
projects.js          list of pages (the panel links to each)
index.html           start()
game.html            start({ project: cupGame })
```

## Add a new project

1. Write `projects/<name>.js` that exports a project object. Every hook is optional;
   the list is at the top of `core/core.js`:
   ```js
   export default {
     title: "My Game",
     help: "<b>space</b> do something",
     setup(core) {},          // core = { Matter, engine, world, canvas, ctx, view, dropBall, clearBalls }
     resize(w, h) {},
     update(now) {},
     draw(ctx, now) {},
     onKey(e) { return false; },       // true = handled
     onPointer(e) { return false; },   // true = handled (no ball dropped)
     onNoteHit(note, ball, speed) {},
   };
   ```
2. Copy `game.html` to `<name>.html` and import your project instead.
3. Add a line to `projects.js`.

Projected colors: never pink or red, the camera would detect them as notes.

## Run

```bash
npx serve .
```
Open the printed URL in Chrome and allow the webcam. `npx serve` also opens pages
without `.html` (`/game`); other static servers need the full name (`/game.html`).
