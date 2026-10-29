/**
 * HSV color-based sticky-note detector for OpenCV.js.
 *
 * Unlike the background-subtraction detector (sheet_detector.js), this finds
 * notes by their COLOR. That makes it immune to a projected image on the same
 * wall: the projected ball is a different colour, so it is ignored.
 * (So never project pink yourself — the camera would see it as a note.)
 *
 * Detection results live in `detector.notes` and are also passed to `onUpdate`.
 * Each note is in CAMERA pixels:
 *   { center: {x,y}, size: {width,height}, angle, area, corners: [{x,y} x4] }
 * Map them to the projector with Calibration (calibration.js).
 *
 * OpenCV.js must already be loaded and available as `globalThis.cv`.
 *
 * HSV ranges use OpenCV conventions: H 0-179, S 0-255, V 0-255.
 * Pink sits at the top of the hue circle and wraps past 179 back to 0, so there
 * are two hue windows: [lower, upper] and `hue2` (shares S/V with the first).
 */
export class NoteDetector {
  constructor(options = {}) {
    this.camera = options.camera ?? "user";
    this.width = options.width ?? 1280;
    this.height = options.height ?? 720;
    this.minArea = options.minArea ?? 1500; // in full camera pixels
    this.rectangularityThreshold = options.rectangularity ?? 0.5;
    this.maxAspectRatio = options.maxAspectRatio ?? 8;

    // Detection runs on a downscaled copy of the frame, at most this wide,
    // and at most `detectFps` times a second. Notes barely move, so this is
    // plenty and leaves the CPU for physics + drawing.
    this.procWidth = options.procWidth ?? 640;
    this.detectFps = options.detectFps ?? 20;

    // Pink HSV window. Mutable at runtime (the tuner writes straight to these).
    this.lower = options.lower ?? [140, 70, 70];
    this.upper = options.upper ?? [179, 255, 255];
    // Second hue window for red-leaning pink, [hMin, hMax]. null disables it.
    this.hue2 = options.hue2 === undefined ? [0, 10] : options.hue2;

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

    const isFacingMode = this.camera === "user" || this.camera === "environment";
    const videoConstraint = isFacingMode
      ? { facingMode: this.camera, width: this.width, height: this.height }
      : { deviceId: { exact: this.camera }, width: this.width, height: this.height };

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraint,
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    // Use the camera's actual resolution if it differs from the requested one.
    this.width = this.video.videoWidth;
    this.height = this.video.videoHeight;
    this.video.width = this.width;
    this.video.height = this.height;
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
        mask: new cv.Mat(),
        mask2: new cv.Mat(),
        // Same physical kernel size as the old full-res 5px / 15px kernels.
        openKernel: cv.getStructuringElement(cv.MORPH_RECT,
          new cv.Size(odd(5 * this.scale), odd(5 * this.scale))),
        closeKernel: cv.getStructuringElement(cv.MORPH_RECT,
          new cv.Size(odd(15 * this.scale), odd(15 * this.scale))),
        low: null, high: null, low2: null, high2: null,
      };
    }

    // cv.inRange needs full-size bound mats in OpenCV.js (no scalar overload),
    // so rebuild them only when the tuner changes a threshold.
    const key = JSON.stringify([this.lower, this.upper, this.hue2]);
    if (key === this.boundsKey) return;
    this.boundsKey = key;

    const m = this.mats;
    for (const name of ["low", "high", "low2", "high2"]) {
      m[name]?.delete();
      m[name] = null;
    }
    const bound = (h, s, v) =>
      new cv.Mat(this.procH, this.procW, cv.CV_8UC3, [h, s, v, 0]);
    m.low = bound(this.lower[0], this.lower[1], this.lower[2]);
    m.high = bound(this.upper[0], this.upper[1], this.upper[2]);
    if (this.hue2) {
      m.low2 = bound(this.hue2[0], this.lower[1], this.lower[2]);
      m.high2 = bound(this.hue2[1], this.upper[1], this.upper[2]);
    }
  }

  #makeMask() {
    const cv = globalThis.cv;
    const m = this.mats;

    // Let the browser do the downscale while copying the frame.
    this.grabCtx.drawImage(this.video, 0, 0, this.procW, this.procH);
    m.frame.data.set(this.grabCtx.getImageData(0, 0, this.procW, this.procH).data);

    cv.cvtColor(m.frame, m.rgb, cv.COLOR_RGBA2RGB);
    cv.GaussianBlur(m.rgb, m.rgb, new cv.Size(5, 5), 0);
    cv.cvtColor(m.rgb, m.hsv, cv.COLOR_RGB2HSV);
    cv.inRange(m.hsv, m.low, m.high, m.mask);
    if (m.low2) {
      cv.inRange(m.hsv, m.low2, m.high2, m.mask2);
      cv.bitwise_or(m.mask, m.mask2, m.mask);
    }
    cv.morphologyEx(m.mask, m.mask, cv.MORPH_OPEN, m.openKernel, new cv.Point(-1, -1), 1);
    cv.morphologyEx(m.mask, m.mask, cv.MORPH_CLOSE, m.closeKernel, new cv.Point(-1, -1), 2);
    if (this.debugCanvas) cv.imshow(this.debugCanvas, m.mask);
    return m.mask;
  }

  #findNotes(mask) {
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
          // Seen at an angle a note is a quadrilateral, not a rectangle: use its
          // real 4 corners when the outline is clean, the fitted rect otherwise.
          const quad = this.#quadCorners(contour);
          found.push({
            center,
            size,
            angle: rect.angle,
            area: area * k * k,
            corners: quad ? quad.map((p) => ({ x: p.x * k, y: p.y * k }))
                          : rectCorners(center, size, rect.angle),
          });
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
    this.notes = this.#findNotes(this.#makeMask());
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
      for (const mat of Object.values(this.mats)) mat?.delete();
      this.mats = null;
      this.boundsKey = "";
    }
    this.stream = null;
    this.video = null;
    this.notes = [];
  }
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
