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

**Owns:** `note_detector.js`, new `calibration.js`. Avoid editing `index.html` (B owns it).
**Branch:** `eyes`

- [ ] **A1. Catch red-leaning pink.** Hue wraps around (…178, 179, 0, 1…). Add a second range (H 0–10 by default, settable as `lower2`/`upper2`) and combine the two masks with `cv.bitwise_or`.
- [ ] **A2. Return corners.** Each note includes its 4 corners (from `minAreaRect`: center, size, angle) in camera pixels.
- [ ] **A3. Speed.** Process a half-size frame (about 640 wide) and scale the results back up. Run detection at about 20 fps (`detectFps` option). Create Mats and kernels once and reuse them; rebuild them only when the thresholds change.
- [ ] **A4. `calibration.js`.**
  - `start()`: enter calibration mode
  - `draw(ctx)`: show 4 numbered white dots near the screen corners, plus the live camera feed in the middle to click on
  - `handleClick(x, y)`: record where dot 1→4 shows up in the camera image (`Backspace` = undo, `Esc` = cancel)
  - after 4 clicks: `cv.getPerspectiveTransform` → homography, saved to `localStorage` (wrapped in try/catch)
  - `camToProj({x,y})`: camera pixel → screen pixel
  - `isCalibrated`, `clear()`
- [ ] **A5. Test.** Point the webcam at the laptop screen and calibrate. A pink object's outline should land on the object.

## 👤 Person B: "World" (physics + show), **teammate**

**Owns:** `index.html` (optionally split the script out into `world.js`).
**Branch:** `world`

- [ ] **B1. Fake notes.** Drag with the mouse to create test notes in the contract shape, so no camera is needed yet.
- [ ] **B2. In-place bodies.** Match notes to existing bodies by nearest center (within about 60px) and move the existing body instead of deleting and re-creating it. Remove a body only after it's been missing for about 5 detections. (Careful: `Body.setVertices` on a static body breaks its infinite mass in Matter.js, so update the vertex x/y, axes and bounds yourself.)
- [ ] **B3. Steady physics.** Fixed timestep: build up real elapsed time and step at 1/60s, at most 4 steps per frame. Notes at least 12px thick, ball speed capped, so balls don't tunnel through.
- [ ] **B4. Projector mode.** `p` = black background, no camera feed, no panel, no cursor. `h` = toggle panel, `o` = toggle note outlines. **Outlines cyan, never pink**: the camera would detect projected pink as a note, and that fake note would never disappear.
- [ ] **B5. Tuner.** Add sliders for the second hue range (H2 min/max) and save all slider values to `localStorage`.
- [ ] **B6. Hooks for A.** `c` → `calibration.start()`, clicks during calibration → `calibration.handleClick()`, `calibration.draw(ctx)` in the frame loop, and notes mapped through `calibration.camToProj` when calibrated. Without calibration, keep the current fit + mirror mapping.

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
