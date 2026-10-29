/**
 * HSV color-based sticky-note detector for OpenCV.js.
 *
 * Unlike the background-subtraction detector (sheet_detector.js), this finds
 * notes by their COLOR. That makes it immune to a projected image on the same
 * wall: the projected ball is a different colour, so it is ignored.
 *
 * Detection results live in `detector.notes` and are also passed to `onUpdate`.
 * OpenCV.js must already be loaded and available as `globalThis.cv`.
 *
 * HSV ranges use OpenCV conventions: H 0-179, S 0-255, V 0-255.
 * Defaults below target neon/magenta PINK.
 */
export class NoteDetector {
  constructor(options = {}) {
    this.camera = options.camera ?? "user";
    this.width = options.width ?? 1280;
    this.height = options.height ?? 720;
    this.minArea = options.minArea ?? 1500;
    this.rectangularityThreshold = options.rectangularity ?? 0.5;
    this.maxAspectRatio = options.maxAspectRatio ?? 8;

    // Pink HSV window. Mutable at runtime (the tuner writes straight to these).
    this.lower = options.lower ?? [140, 70, 70];
    this.upper = options.upper ?? [179, 255, 255];

    this.onUpdate = options.onUpdate ?? null;
    // Optional <canvas>; if set, the binary mask is drawn to it each frame
    // so you can see exactly what the colour threshold is catching.
    this.debugCanvas = options.debugCanvas ?? null;

    this.notes = [];
    this.video = null;
    this.stream = null;
    this.capture = null;
    this.running = false;
    this.animationFrameId = null;
  }

  async start() {
    if (this.running) return;

    const cv = globalThis.cv;
    if (!cv?.Mat || !cv?.VideoCapture) {
      throw new Error("OpenCV.js is not ready. Load opencv.js before start().");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support webcam access.");
    }

    this.video = document.createElement("video");
    this.video.width = this.width;
    this.video.height = this.height;
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
    this.capture = new cv.VideoCapture(this.video);
    this.running = true;

    this.#processNextFrame();
  }

  #makeMask(frame) {
    const cv = globalThis.cv;
    const rgb = new cv.Mat();
    const hsv = new cv.Mat();
    const mask = new cv.Mat();
    const openKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    const closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
    // cv.inRange needs full-size bound mats in OpenCV.js (no scalar overload).
    const low = new cv.Mat(frame.rows, frame.cols, cv.CV_8UC3,
      [this.lower[0], this.lower[1], this.lower[2], 0]);
    const high = new cv.Mat(frame.rows, frame.cols, cv.CV_8UC3,
      [this.upper[0], this.upper[1], this.upper[2], 0]);

    try {
      cv.cvtColor(frame, rgb, cv.COLOR_RGBA2RGB);
      cv.GaussianBlur(rgb, rgb, new cv.Size(7, 7), 0);
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      cv.inRange(hsv, low, high, mask);
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN, openKernel, new cv.Point(-1, -1), 1);
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, closeKernel, new cv.Point(-1, -1), 2);
      if (this.debugCanvas) cv.imshow(this.debugCanvas, mask);
      return mask;
    } finally {
      rgb.delete();
      hsv.delete();
      low.delete();
      high.delete();
      openKernel.delete();
      closeKernel.delete();
    }
  }

  #findNotes(mask) {
    const cv = globalThis.cv;
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    const found = [];

    try {
      cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      for (let index = 0; index < contours.size(); index += 1) {
        const contour = contours.get(index);
        try {
          const area = cv.contourArea(contour);
          if (area < this.minArea) continue;

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

          found.push({
            center: { x: rect.center.x, y: rect.center.y },
            size: { width, height },
            angle: rect.angle,
            area,
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

  #processNextFrame() {
    if (!this.running || !this.capture) return;

    const cv = globalThis.cv;
    const frame = new cv.Mat(this.height, this.width, cv.CV_8UC4);
    let mask = null;
    try {
      this.capture.read(frame);
      mask = this.#makeMask(frame);
      this.notes = this.#findNotes(mask);
      this.onUpdate?.(this.notes);
    } finally {
      mask?.delete();
      frame.delete();
    }

    this.animationFrameId = requestAnimationFrame(() => this.#processNextFrame());
  }

  stop() {
    this.running = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.capture = null;
    this.stream = null;
    this.video = null;
    this.notes = [];
  }
}
