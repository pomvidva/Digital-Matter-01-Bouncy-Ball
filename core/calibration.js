/**
 * Projector <-> camera calibration.
 *
 * The camera looks at the wall from some angle, so a point in the camera image
 * is not where the projector draws it. A homography (3x3 perspective matrix)
 * fixes that: it maps any camera pixel to the matching projector pixel.
 *
 * How it is found (press `c` in the app):
 *   1. The projector shows 4 numbered dots near the corners of the screen.
 *   2. The live camera image is shown in the middle of the screen.
 *   3. You click where dot 1, 2, 3, 4 appear in that camera image.
 *   4. 4 camera points + 4 projector points -> homography, saved in localStorage.
 *
 * Projector points are stored as fractions of the screen (0..1), so the
 * calibration survives a window resize / switching to fullscreen.
 *
 * Usage:
 *   const calibration = new Calibration();
 *   calibration.start(detector.video, detector.width, detector.height);
 *   // in the draw loop:   if (calibration.active) calibration.draw(ctx);
 *   // on pointerdown:     if (calibration.handleClick(x, y)) return;
 *   // on pointermove:     calibration.handleMove(x, y);
 *   // on keydown:         if (calibration.handleKey(e.key)) return;
 *   // mapping:            calibration.mapNotes(detector.notes, canvas.width, canvas.height)
 */

// Where the dots go, as fractions of the screen: TL, TR, BR, BL (clockwise).
const DEFAULT_TARGETS = [
  { x: 0.08, y: 0.08 },
  { x: 0.92, y: 0.08 },
  { x: 0.92, y: 0.92 },
  { x: 0.08, y: 0.92 },
];

export class Calibration {
  constructor(options = {}) {
    this.storageKey = options.storageKey ?? "dm01.calibration";
    this.targets = options.targets ?? DEFAULT_TARGETS;

    this.active = false;   // true while the user is clicking the 4 dots
    this.clicks = [];      // camera-pixel points clicked so far
    this.camPoints = null; // the 4 saved camera points
    this.camW = 0;         // camera resolution the calibration was made with
    this.camH = 0;
    this.H = null;         // camera px -> screen fraction, 9 numbers row-major

    this.video = null;
    this.mouse = null;
    this.pip = null;       // where the camera image is drawn during calibration

    this.load();
  }

  get isCalibrated() {
    return this.H !== null;
  }

  /** True if the saved calibration was made with a camera of this size. */
  matchesCamera(width, height) {
    return this.camW === width && this.camH === height;
  }

  start(video, camW, camH) {
    this.video = video;
    this.startCamW = camW;
    this.startCamH = camH;
    this.clicks = [];
    this.active = true;
  }

  cancel() {
    this.active = false;
    this.clicks = [];
  }

  clear() {
    this.H = null;
    this.camPoints = null;
    try { localStorage.removeItem(this.storageKey); } catch {}
  }

  // ---------- input ----------

  /** Returns true if the click was used by calibration. */
  handleClick(x, y) {
    if (!this.active) return false;
    const cam = this.#screenToCam(x, y);
    if (!cam) return true; // clicked outside the camera image: ignore

    this.clicks.push(cam);
    if (this.clicks.length === this.targets.length) {
      this.#finish();
    }
    return true;
  }

  handleMove(x, y) {
    this.mouse = { x, y };
  }

  /** Returns true if the key was used by calibration. */
  handleKey(key) {
    if (!this.active) return false;
    if (key === "Escape") this.cancel();
    else if (key === "Backspace") this.clicks.pop();
    return true;
  }

  // ---------- mapping ----------

  /** Camera pixel -> screen pixel on a screen of size w x h. */
  camToProj(p, w, h) {
    if (!this.H) return { x: p.x, y: p.y };
    const f = applyHomography(this.H, p);
    return { x: f.x * w, y: f.y * h };
  }

  /** Detector notes -> the contract shape { corners, center } in screen pixels. */
  mapNotes(notes, w, h) {
    return notes.map((note) => ({
      corners: note.corners.map((c) => this.camToProj(c, w, h)),
      center: this.camToProj(note.center, w, h),
    }));
  }

  // ---------- drawing (only while active) ----------

  draw(ctx) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const next = this.clicks.length;

    ctx.save();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    // Target dots the camera has to see. White/yellow only: never pink.
    const r = Math.max(10, Math.min(w, h) * 0.025);
    this.targets.forEach((t, i) => {
      const x = t.x * w;
      const y = t.y * h;
      const isNext = i === next;
      ctx.strokeStyle = ctx.fillStyle = isNext ? "#ffd23f" : i < next ? "#555" : "#fff";
      ctx.lineWidth = isNext ? 4 : 2;
      ctx.beginPath();
      ctx.arc(x, y, isNext ? r * 1.4 : r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - r * 2, y); ctx.lineTo(x + r * 2, y);
      ctx.moveTo(x, y - r * 2); ctx.lineTo(x, y + r * 2);
      ctx.stroke();
      ctx.font = `bold ${Math.round(r * 1.2)}px ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), x + (t.x < 0.5 ? r * 2.6 : -r * 2.6), y + (t.y < 0.5 ? r * 2.6 : -r * 2.6));
    });

    // Live camera image in the middle (not mirrored: clicks map 1:1 to camera pixels).
    const camW = this.startCamW;
    const camH = this.startCamH;
    const s = Math.min((w * 0.56) / camW, (h * 0.56) / camH);
    this.pip = { x: (w - camW * s) / 2, y: (h - camH * s) / 2, s };
    const pip = this.pip;
    if (isDrawable(this.video)) {
      ctx.drawImage(this.video, pip.x, pip.y, camW * s, camH * s);
    }
    ctx.strokeStyle = "#3a4b5e";
    ctx.lineWidth = 1;
    ctx.strokeRect(pip.x, pip.y, camW * s, camH * s);

    // Points clicked so far.
    ctx.fillStyle = "#3ff";
    ctx.font = "bold 14px ui-monospace, monospace";
    this.clicks.forEach((c, i) => {
      const x = pip.x + c.x * s;
      const y = pip.y + c.y * s;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(String(i + 1), x + 12, y - 12);
    });

    // Instructions.
    ctx.fillStyle = "#fff";
    ctx.font = "16px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(
      `CALIBRATION: click dot ${next + 1} of ${this.targets.length} in the camera image`,
      w / 2, pip.y - 30);
    ctx.fillStyle = "#8fb";
    ctx.fillText("Backspace = undo · Esc = cancel", w / 2, pip.y - 10);

    this.#drawLoupe(ctx);
    ctx.restore();
  }

  // Zoomed view under the mouse, so clicks can be placed precisely.
  #drawLoupe(ctx) {
    const cam = this.mouse && this.#screenToCam(this.mouse.x, this.mouse.y);
    if (!cam || !isDrawable(this.video)) return;

    const box = 150;
    const zoom = 4;
    const srcSize = box / (this.pip.s * zoom); // in camera pixels
    let dx = this.mouse.x + 24;
    let dy = this.mouse.y + 24;
    if (dx + box > ctx.canvas.width) dx = this.mouse.x - 24 - box;
    if (dy + box > ctx.canvas.height) dy = this.mouse.y - 24 - box;

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(dx, dy, box, box);
    ctx.drawImage(this.video,
      cam.x - srcSize / 2, cam.y - srcSize / 2, srcSize, srcSize,
      dx, dy, box, box);
    ctx.strokeStyle = "#3ff";
    ctx.lineWidth = 1;
    ctx.strokeRect(dx, dy, box, box);
    ctx.beginPath();
    ctx.moveTo(dx + box / 2, dy); ctx.lineTo(dx + box / 2, dy + box);
    ctx.moveTo(dx, dy + box / 2); ctx.lineTo(dx + box, dy + box / 2);
    ctx.stroke();
    ctx.restore();
  }

  // ---------- internals ----------

  #screenToCam(x, y) {
    if (!this.pip) return null;
    const cx = (x - this.pip.x) / this.pip.s;
    const cy = (y - this.pip.y) / this.pip.s;
    if (cx < 0 || cy < 0 || cx > this.startCamW || cy > this.startCamH) return null;
    return { x: cx, y: cy };
  }

  #finish() {
    const H = solveHomography(this.clicks, this.targets);
    this.active = false;
    if (!H) {
      // Degenerate clicks (e.g. 3 in a line). Keep the old calibration.
      console.warn("Calibration failed: the 4 points must form a proper quadrilateral.");
      this.clicks = [];
      return;
    }
    this.H = H;
    this.camPoints = this.clicks;
    this.camW = this.startCamW;
    this.camH = this.startCamH;
    this.clicks = [];
    this.save();
  }

  save() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({
        v: 1, camW: this.camW, camH: this.camH,
        cam: this.camPoints, proj: this.targets,
      }));
    } catch {}
  }

  load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(this.storageKey)); } catch {}
    if (saved?.v !== 1 || saved.cam?.length !== 4 || saved.proj?.length !== 4) return;
    const H = solveHomography(saved.cam, saved.proj);
    if (!H) return;
    this.H = H;
    this.camPoints = saved.cam;
    this.camW = saved.camW;
    this.camH = saved.camH;
  }
}

function isDrawable(src) {
  if (!src) return false;
  return src.readyState === undefined || src.readyState >= 2;
}

/**
 * Homography mapping 4 `src` points onto 4 `dst` points.
 * Returns 9 numbers (row-major, h[8] = 1), or null if the points are degenerate.
 */
export function solveHomography(src, dst) {
  // For each pair: x' = (h0 x + h1 y + h2) / (h6 x + h7 y + 1), same for y'.
  // Rearranged that is 2 linear equations per pair -> 8 equations, 8 unknowns.
  const A = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }

  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    }
    if (Math.abs(A[pivot][col]) < 1e-10) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const f = A[row][col] / A[col][col];
      for (let k = col; k < 9; k++) A[row][k] -= f * A[col][k];
    }
  }

  const h = A.map((row, i) => row[8] / row[i]);
  h.push(1);
  return h;
}

export function applyHomography(H, p) {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  };
}
