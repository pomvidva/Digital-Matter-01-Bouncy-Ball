# Digital Matter 01: Tasks

Goal: wall-ready **today**, for the room + projector test on **Monday**.

A projector shows bouncing balls on a wall, a webcam tracks pink sticky notes, and the balls bounce off them.

---

## 🤝 The contract (agree on this first)

What **A** hands to **B**, in **screen/projector pixels**:

```js
notes = [
  { corners: [{x,y}, {x,y}, {x,y}, {x,y}], center: {x,y} },
  // ...
]
```

As long as both of you stick to this shape, you can work at the same time without waiting on each other.

---

## 👤 Person A: "Eyes" (camera + calibration), **me**

**Owns:** `core/note_detector.js`, `core/calibration.js`. Avoid editing `core/core.js` (B owns it).
**Branch:** `eyes`

- [x] **A1. Catch red-leaning pink.** Hue wraps around (…178, 179, 0, 1…). Second hue window `detector.hue2 = [0, 10]` (shares S/V with the main range; `null` turns it off), combined with `cv.bitwise_or`.
- [x] **A2. Return corners.** Each note has `corners` (4 points, camera pixels). It uses the note's real outline when it's a clean quadrilateral (accurate when seen at an angle), and falls back to `minAreaRect` otherwise.
- [x] **A3. Speed.** Detection runs on a ≤640px-wide copy at most 20 fps (`procWidth`, `detectFps` options). Mats and kernels are reused, and bounds are rebuilt only when a threshold changes. `detector.frameCount` bumps once per new detection, and `detector.detectMs` = time it took.
- [x] **A4. `calibration.js`.** `start(video, camW, camH)`, `draw(ctx)`, `handleClick(x, y)`, `handleMove(x, y)` (zoom loupe), `handleKey(key)` (`Backspace` = undo, `Esc` = cancel), `isCalibrated`, `clear()`, `camToProj(p, w, h)`, `mapNotes(notes, w, h)` → contract shape. Homography solved in plain JS (tested), saved in `localStorage`.
- [ ] **A5. Test with the real webcam.** Point the webcam at the laptop screen and calibrate. A pink object's outline should land on the object. (Already tested without a webcam: `dev/eyes_test.html`, see below.)

**No-webcam test page:** run the server, open `/dev/eyes_test.html`. A fake tilted camera with 3 notes and a yellow ball. `a` = auto-calibrate, `c` = by hand, `m` = mask. Center error should be about 2px.

## 👤 Person B: "World" (physics + show), **teammate**

**Owns:** `core/core.js` (was the script inside `index.html`).
**Branch:** `world`

- [ ] **B1. Fake notes.** Drag with the mouse to create test notes in the contract shape, so no camera is needed yet.
- [ ] **B2. In-place bodies.** Match notes to existing bodies by nearest center (within about 60px) and move the existing body instead of deleting and re-creating it. Remove a body only after it's been missing for about 5 detections. (Careful: `Body.setVertices` on a static body breaks its infinite mass in Matter.js, so update the vertex x/y, axes and bounds yourself.)
- [ ] **B3. Steady physics.** Fixed timestep: build up real elapsed time and step at 1/60s, at most 4 steps per frame. Notes at least 12px thick, ball speed capped, so balls don't tunnel through.
- [ ] **B4. Projector mode.** `p` = black background, no camera feed, no panel, no cursor. `h` = toggle panel, `o` = toggle note outlines. **Outlines cyan, never pink**: the camera would detect projected pink as a note, and that fake note would never disappear.
- [ ] **B5. Tuner.** Add sliders for the second hue range (H2 min/max) and save all slider values to `localStorage`.
- [ ] **B6. Hooks for A.** A's side is ready. Wire it up like this:
  ```js
  import { Calibration } from "./calibration.js";
  const calibration = new Calibration();            // loads the saved one
  // keydown:     if (calibration.handleKey(e.key)) return;
  //              "c" -> calibration.start(detector.video, detector.width, detector.height)
  //              "C" (shift) -> calibration.clear()
  // pointerdown: if (calibration.handleClick(e.clientX, e.clientY)) return;
  // pointermove: calibration.handleMove(e.clientX, e.clientY);
  // frame:       if (calibration.active) { calibration.draw(ctx); hide panel; skip the rest }
  // notes:       calibration.isCalibrated
  //                ? calibration.mapNotes(detector.notes, canvas.width, canvas.height)
  //                : current fit + mirror mapping
  ```
  Hide the panel while calibrating, or it covers dot 1. Only re-sync bodies when `detector.frameCount` changes, so the "missing for 5 detections" grace period counts detections, not draw frames. That grace period matters: when a projected ball passes over a note, the camera sees the note's color change and its outline can glitch for a moment.

## 👥 Together (end of today)

- [ ] **Merge** `eyes` + `world` into `main`; real notes replace fake notes.
- [ ] **Mock-wall test:** webcam pointed at a monitor running projector mode. Calibrate (`c`), put pink notes in front of the screen. Balls should rest on them without jitter, and moving a note should push the balls.
- [ ] **Reload test:** calibration and slider values are still there.

## 📽️ Monday checklist

- [ ] Chrome on the projector display → `f` fullscreen → `p` projector mode
- [ ] Tape or clamp the webcam in place **before** calibrating; recalibrate (`c`) if it moves
- [ ] Tune the color sliders under the room's lighting (check with `m` mask view); dim the lights if possible
- [ ] Record video for the portfolio 🎥

---

## Later (exploration, after Monday)

- A: auto-calibration (project a white rectangle and detect its corners, no clicking)
- B: ball trails, notes that glow when hit, a sound per note
- Both: different note colors with different behaviors (bouncy, sticky, portal, goal)
- README with a GIF + how-it-works diagram for the bit.studio application
- Move the old `app.js` + `sheet_detector.js` into `/old`

## How to run

```bash
npx serve .
```
Open the printed URL in Chrome and allow the webcam.
