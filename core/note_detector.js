/**
 * HSV color-based sticky-note detector for OpenCV.js.
 *
 * Unlike the background-subtraction detector (sheet_detector.js), this finds
 * notes by their COLOR. That makes it immune to a projected image on the same
 * wall: the projected ball is a different colour, so it is ignored.
 * (So never project pink yourself — the camera would see it as a note.)
 *
 * Several note colors are found in one pass (`detector.colors`, see
 * defaultColors()); each note says which one it is.
 *
 * Detection results live in `detector.notes` and are also passed to `onUpdate`.
 * Each note is in CAMERA pixels:
 *   { color: "pink" | "green" | "blue", center: {x,y}, size: {width,height},
 *     angle, area, corners: [{x,y} x4],
 *     outline: [{x,y}, ...] }   // convex hull of the blob, dents filled in
 * Map them to the projector with Calibration (calibration.js).
 *
 * OpenCV.js must already be loaded and available as `globalThis.cv`.
 *
 * HSV ranges use OpenCV conventions: H 0-179, S 0-255, V 0-255.
 * Pink sits at the top of the hue circle and wraps past 179 back to 0, so a
 * color can have two hue windows: [lower, upper] and `hue2` (shares S/V).
 */
// Laptop cameras usually carry one of these words in their label.
// ("HD WebCam" / "HD User Facing" are common names for laptop cameras too.)
const BUILT_IN_CAMERA = /integrated|built-?in|facetime|internal|front|ir camera|hd webcam|user facing/i;
// External webcams often just say "USB" in the name (e.g. "USB 2.0 Camera").
const EXTERNAL_CAMERA = /usb/i;

export class NoteDetector {
  /** All video inputs. Labels are empty until camera permission was granted once. */
  static async listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
  }

  constructor(options = {}) {
    // "auto" (default) = prefer an external USB webcam over the laptop's built-in one.
    // Also accepts "user" / "environment" (facingMode) or a deviceId.
    this.camera = options.camera ?? "auto";
    this.reqWidth = options.width ?? 1280;
    this.reqHeight = options.height ?? 720;
    this.width = this.reqWidth;
    this.height = this.reqHeight;
    this.cameraId = "";    // deviceId of the camera actually opened
    this.cameraLabel = ""; // its name, e.g. "Logitech C920"
    // in full camera pixels: 400 = a 20x20 blob, about one sticky note seen
    // from across a room (1500 needed several notes stuck together)
    this.minArea = options.minArea ?? 400;
    this.rectangularityThreshold = options.rectangularity ?? 0.5;
    this.maxAspectRatio = options.maxAspectRatio ?? 8;

    // Detection runs on a downscaled copy of the frame, at most this wide,
    // and at most `detectFps` times a second. Notes barely move, so this is
    // plenty and leaves the CPU for physics + drawing.
    this.procWidth = options.procWidth ?? 640;
    this.detectFps = options.detectFps ?? 20;

    // One HSV window per note color: { lower, upper, hue2 }. Mutable at runtime
    // (the tuner writes straight to these). `hue2` is a second hue window
    // [hMin, hMax] sharing S/V, for hues that wrap past 179 (pink); null = off.
    // Each note comes back with `color` set to the key it matched.
    this.colors = options.colors ?? defaultColors();
    // old single-color options still set pink
    if (options.lower) this.colors.pink.lower = options.lower;
    if (options.upper) this.colors.pink.upper = options.upper;
    if (options.hue2 !== undefined) this.colors.pink.hue2 = options.hue2;
    // Which color the debug mask shows; null = all of them.
    this.debugColor = options.debugColor ?? null;

    this.onUpdate = options.onUpdate ?? null;
    // Optional <canvas>; if set, the binary mask is drawn to it each frame
    // so you can see exactly what the colour threshold is catching.
    this.debugCanvas = options.debugCanvas ?? null;
    // Optional <video>/<canvas>/<img> to read instead of the webcam (testing).
    this.source = options.source ?? null;

    this.notes = [];
    this.frameCount = 0; // bumps once per finished detection
    this.detectMs = 0;   // how long the last detection took
    this.video = null;
    this.stream = null;
    this.running = false;
    this.animationFrameId = null;
    this.lastDetectAt = 0;

    this.mats = null;      // reused OpenCV buffers, see #ensureMats
    this.boundsKey = "";   // thresholds the bound Mats were built for
  }

  // Pink's window under the old single-color names.
  get lower() { return this.colors.pink.lower; }
  set lower(v) { this.colors.pink.lower = v; }
  get upper() { return this.colors.pink.upper; }
  set upper(v) { this.colors.pink.upper = v; }
  get hue2() { return this.colors.pink.hue2; }
  set hue2(v) { this.colors.pink.hue2 = v; }

  async start() {
    if (this.running) return;

    const cv = globalThis.cv;
    if (!cv?.Mat) {
      throw new Error("OpenCV.js is not ready. Load opencv.js before start().");
    }

    if (this.source) {
      this.video = this.source;
      this.width = this.source.videoWidth || this.source.width;
      this.height = this.source.videoHeight || this.source.height;
    } else {
      await this.#openWebcam();
    }

    const scale = Math.min(1, this.procWidth / this.width);
    this.procW = Math.round(this.width * scale);
    this.procH = Math.round(this.height * scale);
    this.scale = this.procW / this.width;

    this.grabCanvas = document.createElement("canvas");
    this.grabCanvas.width = this.procW;
    this.grabCanvas.height = this.procH;
    this.grabCtx = this.grabCanvas.getContext("2d", { willReadFrequently: true });

    this.running = true;
    this.#processNextFrame();
  }

  async #openWebcam() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support webcam access.");
    }

    this.video = document.createElement("video");
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;

    const size = { width: this.reqWidth, height: this.reqHeight };
    const open = (video) => navigator.mediaDevices.getUserMedia({ video, audio: false });

    if (this.camera === "auto") {
      // Open any camera first: device labels stay empty until permission is granted.
      this.stream = await open(size);
      const cams = await NoteDetector.listCameras();
      const current = this.stream.getVideoTracks()[0]?.getSettings().deviceId;
      const pick = cams.find((c) => EXTERNAL_CAMERA.test(c.label))
        ?? cams.find((c) => !BUILT_IN_CAMERA.test(c.label))
        ?? cams[0];
      if (pick && pick.deviceId !== current) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = await open({ ...size, deviceId: { exact: pick.deviceId } });
      }
    } else if (this.camera === "user" || this.camera === "environment") {
      this.stream = await open({ ...size, facingMode: this.camera });
    } else {
      this.stream = await open({ ...size, deviceId: { exact: this.camera } });
    }

    const track = this.stream.getVideoTracks()[0];
    this.cameraId = track?.getSettings().deviceId ?? "";
    this.cameraLabel = track?.label ?? "";
    this.video.srcObject = this.stream;
    await this.video.play();

    // Use the camera's actual resolution if it differs from the requested one.
    this.width = this.video.videoWidth;
    this.height = this.video.videoHeight;
    this.video.width = this.width;
    this.video.height = this.height;
  }

  /**
   * Freeze (lock=true) or release the camera's auto exposure / white balance /
   * focus, so note colors stop drifting when the projected image changes.
   * Locks at the CURRENT values. Returns { locked: [...], unsupported: [...] }.
   */
  async lockCamera(lock, { exposureTime } = {}) {
    const track = this.stream?.getVideoTracks()[0];
    if (!track?.getCapabilities) return { locked: [], unsupported: ["exposure", "white balance", "focus"] };
    const caps = track.getCapabilities();
    const now = track.getSettings();
    const controls = [
      // [name, mode key, value key that holds the current setting]
      ["exposure", "exposureMode", "exposureTime"],
      ["white balance", "whiteBalanceMode", "colorTemperature"],
      ["focus", "focusMode", "focusDistance"],
    ];
    const locked = [], unsupported = [];
    for (const [name, modeKey, valueKey] of controls) {
      const want = lock ? "manual" : "continuous";
      if (!caps[modeKey]?.includes(want)) { unsupported.push(name); continue; }
      const c = { [modeKey]: want };
      // keep today's value, otherwise "manual" may jump to some default (often very dark)
      let value = now[valueKey];
      if (valueKey === "exposureTime" && exposureTime !== undefined) value = exposureTime;
      if (lock && value !== undefined) c[valueKey] = value;
      try {
        await track.applyConstraints({ advanced: [c] });
        locked.push(name);
      } catch {
        unsupported.push(name);
      }
    }
    // range + value for an exposure slider (units are camera specific)
    const range = caps.exposureTime;
    const exposure = lock && locked.includes("exposure") && range
      ? { min: range.min, max: range.max, step: range.step || 1,
          value: track.getSettings().exposureTime ?? exposureTime ?? range.min }
      : null;
    return { locked, unsupported, exposure };
  }

  /** Manual exposure time (only after lockCamera(true) locked exposure). */
  async setExposure(value) {
    const track = this.stream?.getVideoTracks()[0];
    await track?.applyConstraints({ advanced: [{ exposureMode: "manual", exposureTime: value }] });
  }

  // Allocate the per-frame buffers once instead of every frame.
  #ensureMats() {
    const cv = globalThis.cv;
    if (!this.mats) {
      const odd = (n) => Math.max(3, Math.round(n) | 1);
      this.mats = {
        frame: new cv.Mat(this.procH, this.procW, cv.CV_8UC4),
        rgb: new cv.Mat(),
        hsv: new cv.Mat(),
        mask: new cv.Mat(),   // all colors OR'd, cleaned up: where the notes are
        mask2: new cv.Mat(),  // scratch: a color's hue2 window
        blob: new cv.Mat(),   // scratch: one contour filled, for counting its colors
        hit: new cv.Mat(),    // scratch: blob AND one color
        none: new cv.Mat(),   // empty hierarchy for drawContours
        // Same physical kernel size as the old full-res 5px / 15px kernels.
        openKernel: cv.getStructuringElement(cv.MORPH_RECT,
          new cv.Size(odd(5 * this.scale), odd(5 * this.scale))),
        closeKernel: cv.getStructuringElement(cv.MORPH_RECT,
          new cv.Size(odd(15 * this.scale), odd(15 * this.scale))),
        bounds: {},   // color -> { low, high, low2, high2 }
        colorMasks: {}, // color -> raw (uncleaned) mask of just that color
      };
    }

    // cv.inRange needs full-size bound mats in OpenCV.js (no scalar overload),
    // so rebuild them only when the tuner changes a threshold.
    const key = JSON.stringify(this.colors);
    if (key === this.boundsKey) return;
    this.boundsKey = key;

    const m = this.mats;
    this.#deleteBounds();
    const bound = (h, s, v) =>
      new cv.Mat(this.procH, this.procW, cv.CV_8UC3, [h, s, v, 0]);
    for (const [name, { lower, upper, hue2 }] of Object.entries(this.colors)) {
      const b = { low: bound(...lower), high: bound(...upper), low2: null, high2: null };
      if (hue2) {
        b.low2 = bound(hue2[0], lower[1], lower[2]);
        b.high2 = bound(hue2[1], upper[1], upper[2]);
      }
      m.bounds[name] = b;
    }
  }

  #deleteBounds() {
    const bounds = this.mats?.bounds ?? {};
    for (const b of Object.values(bounds)) for (const mat of Object.values(b)) mat?.delete();
    for (const mat of Object.values(this.mats?.colorMasks ?? {})) mat.delete();
    if (this.mats) { this.mats.bounds = {}; this.mats.colorMasks = {}; }
  }

  // Grab + blur + HSV once per detection; every color's mask is cut from this.
  #toHsv() {
    const cv = globalThis.cv;
    const m = this.mats;

    // Let the browser do the downscale while copying the frame.
    this.grabCtx.drawImage(this.video, 0, 0, this.procW, this.procH);
    m.frame.data.set(this.grabCtx.getImageData(0, 0, this.procW, this.procH).data);

    cv.cvtColor(m.frame, m.rgb, cv.COLOR_RGBA2RGB);
    cv.GaussianBlur(m.rgb, m.rgb, new cv.Size(5, 5), 0);
    cv.cvtColor(m.rgb, m.hsv, cv.COLOR_RGB2HSV);
  }

  // Raw mask of one color (no cleanup) into m.colorMasks[name].
  #colorMask(name, b) {
    const cv = globalThis.cv;
    const m = this.mats;
    const out = (m.colorMasks[name] ??= new cv.Mat());
    cv.inRange(m.hsv, b.low, b.high, out);
    if (b.low2) {
      cv.inRange(m.hsv, b.low2, b.high2, m.mask2);
      cv.bitwise_or(out, m.mask2, out);
    }
    return out;
  }

  // Find blobs once on all colors together, then give each blob the color most
  // of its pixels have. Cleaning up (open/close) is by far the slowest step, so
  // doing it once instead of once per color keeps several colors as cheap as one.
  // Catch: two notes of different colors that touch become one blob, one color.
  #detect() {
    const cv = globalThis.cv;
    const m = this.mats;
    this.#toHsv();
    const names = Object.keys(m.bounds);
    names.forEach((name, i) => {
      const raw = this.#colorMask(name, m.bounds[name]);
      if (i === 0) raw.copyTo(m.mask); else cv.bitwise_or(m.mask, raw, m.mask);
    });
    cv.morphologyEx(m.mask, m.mask, cv.MORPH_OPEN, m.openKernel, new cv.Point(-1, -1), 1);
    cv.morphologyEx(m.mask, m.mask, cv.MORPH_CLOSE, m.closeKernel, new cv.Point(-1, -1), 2);
    if (this.debugCanvas) {
      // tuning one color: show just its raw mask; otherwise what the blobs come from
      cv.imshow(this.debugCanvas, m.colorMasks[this.debugColor] ?? m.mask);
    }
    return this.#findNotes(m.mask, (contour, contours, index) => this.#blobColor(contour, contours, index));
  }

  // The color with the most pixels inside contour `index`.
  #blobColor(contour, contours, index) {
    const cv = globalThis.cv;
    const m = this.mats;
    const r = cv.boundingRect(contour);
    m.blob.delete();
    m.blob = cv.Mat.zeros(r.height, r.width, cv.CV_8UC1);
    cv.drawContours(m.blob, contours, index, new cv.Scalar(255), -1, cv.LINE_8,
      m.none, 0, new cv.Point(-r.x, -r.y));
    let best = null, bestCount = -1;
    for (const [name, mask] of Object.entries(m.colorMasks)) {
      const roi = mask.roi(r);
      try {
        cv.bitwise_and(roi, m.blob, m.hit);
        const count = cv.countNonZero(m.hit);
        if (count > bestCount) { best = name; bestCount = count; }
      } finally {
        roi.delete();
      }
    }
    return best;
  }

  // classify(contour, contours, index) -> color name, called for each note kept
  #findNotes(mask, classify) {
    const cv = globalThis.cv;
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    const found = [];
    const k = 1 / this.scale; // processing pixels -> camera pixels
    const minArea = this.minArea * this.scale * this.scale;

    try {
      cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      for (let index = 0; index < contours.size(); index += 1) {
        const contour = contours.get(index);
        try {
          const area = cv.contourArea(contour);
          if (area < minArea) continue;

          const rect = cv.minAreaRect(contour);
          const width = rect.size.width;
          const height = rect.size.height;
          const rectangleArea = width * height;
          if (rectangleArea === 0) continue;

          const rectangularity = area / rectangleArea;
          const aspectRatio = Math.max(width, height) / Math.max(1, Math.min(width, height));
          if (
            rectangularity < this.rectangularityThreshold ||
            aspectRatio > this.maxAspectRatio
          ) {
            continue;
          }

          const center = { x: rect.center.x * k, y: rect.center.y * k };
          const size = { width: width * k, height: height * k };
          // Convex hull: a curled corner or a shadow bites a notch out of the mask,
          // the hull fills it back in. Its shape is also far steadier frame to frame.
          const hull = new cv.Mat();
          try {
            cv.convexHull(contour, hull, false, true);
            // Seen at an angle a note is a quadrilateral, not a rectangle: use its
            // real 4 corners when the outline is clean, the fitted rect otherwise.
            const quad = this.#quadCorners(hull);
            const h = hull.data32S;
            const outline = [];
            for (let i = 0; i < hull.rows; i++) outline.push({ x: h[i * 2] * k, y: h[i * 2 + 1] * k });
            found.push({
              color: classify?.(contour, contours, index),
              center,
              size,
              angle: rect.angle,
              area: area * k * k,
              corners: quad ? quad.map((p) => ({ x: p.x * k, y: p.y * k }))
                            : rectCorners(center, size, rect.angle),
              outline,
            });
          } finally {
            hull.delete();
          }
        } finally {
          contour.delete();
        }
      }
    } finally {
      contours.delete();
      hierarchy.delete();
    }

    return found;
  }

  // 4 convex corners of the outline in clockwise order, or null.
  #quadCorners(contour) {
    const cv = globalThis.cv;
    const approx = new cv.Mat();
    try {
      cv.approxPolyDP(contour, approx, 0.04 * cv.arcLength(contour, true), true);
      if (approx.rows !== 4 || !cv.isContourConvex(approx)) return null;
      const d = approx.data32S;
      const pts = [0, 1, 2, 3].map((i) => ({ x: d[i * 2], y: d[i * 2 + 1] }));
      const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
      const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
      return pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    } finally {
      approx.delete();
    }
  }

  #processNextFrame() {
    if (!this.running) return;
    this.animationFrameId = requestAnimationFrame(() => this.#processNextFrame());

    const now = performance.now();
    if (now - this.lastDetectAt < 1000 / this.detectFps - 2) return;
    // Webcam not delivering frames yet (or paused).
    if (this.video.readyState !== undefined && this.video.readyState < 2) return;
    this.lastDetectAt = now;

    this.#ensureMats();
    this.notes = this.#detect();
    this.frameCount += 1;
    this.detectMs = performance.now() - now;
    this.onUpdate?.(this.notes);
  }

  stop() {
    this.running = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.mats) {
      this.#deleteBounds();
      const { bounds, colorMasks, ...mats } = this.mats;
      for (const mat of Object.values(mats)) mat?.delete();
      this.mats = null;
      this.boundsKey = "";
    }
    this.stream = null;
    this.video = null;
    this.notes = [];
  }
}

/**
 * Starting HSV windows (OpenCV: H 0-179). Tune on the real wall with the panel.
 *   pink   magenta..red, wraps past 179 (hue2)
 *   green  yellow-green..green. Starts above 25 so yellow/orange (calibration
 *          dots, "NEW BEST") is not green.
 *   blue   cyan..blue
 * Never project a color inside one of these: the camera would see it as a note.
 */
export function defaultColors() {
  return {
    pink: { lower: [140, 70, 70], upper: [179, 255, 255], hue2: [0, 10] },
    green: { lower: [30, 60, 60], upper: [85, 255, 255], hue2: null },
    blue: { lower: [88, 80, 60], upper: [128, 255, 255], hue2: null },
  };
}

/**
 * The 4 corners of an OpenCV RotatedRect (same order as cv.RotatedRect.points):
 * bottom-left, top-left, top-right, bottom-right for an unrotated rect.
 */
export function rectCorners(center, size, angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  const b = Math.cos(a) * 0.5;
  const s = Math.sin(a) * 0.5;
  const p0 = {
    x: center.x - s * size.height - b * size.width,
    y: center.y + b * size.height - s * size.width,
  };
  const p1 = {
    x: center.x + s * size.height - b * size.width,
    y: center.y - b * size.height - s * size.width,
  };
  return [
    p0,
    p1,
    { x: 2 * center.x - p0.x, y: 2 * center.y - p0.y },
    { x: 2 * center.x - p1.x, y: 2 * center.y - p1.y },
  ];
}
