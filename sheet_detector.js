/**
 * Reusable webcam sheet detector for OpenCV.js.
 *
 * This module does not draw a preview or bounding boxes. Detection results are
 * kept in `detector.sheets` and can also be received through `onUpdate`.
 * OpenCV.js must already be loaded and available as `globalThis.cv`.
 */
export class SheetDetector {
  constructor(options = {}) {
    this.camera = options.camera ?? "user";
    this.width = options.width ?? 1280;
    this.height = options.height ?? 720;
    this.minArea = options.minArea ?? 2000;
    this.differenceThreshold = options.threshold ?? 25;
    this.warmupMs = options.warmupMs ?? 2000;
    this.rectangularityThreshold = options.rectangularity ?? 0.55;
    this.maxAspectRatio = options.maxAspectRatio ?? 8;
    this.onUpdate = options.onUpdate ?? null;

    this.sheets = [];
    this.video = null;
    this.stream = null;
    this.capture = null;
    this.background = null;
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

    const preview = document.querySelector("#camera-feed");
    if (preview) {
      preview.srcObject = null;
      preview.width = this.width;
      preview.height = this.height;
      preview.muted = true;
      preview.playsInline = true;
    }

    const isFacingMode = this.camera === "user" || this.camera === "environment";
    const videoConstraint = isFacingMode
      ? { facingMode: this.camera, width: this.width, height: this.height }
      : { deviceId: { exact: this.camera }, width: this.width, height: this.height };

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraint,
      audio: false,
    });
    this.video.srcObject = this.stream;
    if (preview) {
      preview.srcObject = this.stream;
      preview.muted = true;
      await preview.play();
    }
    await this.video.play();

    // Use the camera's actual resolution if it differs from the requested one.
    this.width = this.video.videoWidth;
    this.height = this.video.videoHeight;
    this.video.width = this.width;
    this.video.height = this.height;
    this.capture = new cv.VideoCapture(this.video);
    this.running = true;

    // Allow exposure and white balance to settle before saving the empty wall.
    await new Promise((resolve) => setTimeout(resolve, this.warmupMs));
    if (!this.running) return;
    this.captureBackground();
    this.#processNextFrame();
  }

  captureBackground() {
    if (!this.capture) {
      throw new Error("Call start() before captureBackground().");
    }

    const cv = globalThis.cv;
    const frame = new cv.Mat(this.height, this.width, cv.CV_8UC4);
    try {
      this.capture.read(frame);
      this.background?.delete();
      this.background = frame.clone();
      this.sheets = [];
    } finally {
      frame.delete();
    }
  }

  #makeMask(frame) {
    const cv = globalThis.cv;
    const frameBlur = new cv.Mat();
    const backgroundBlur = new cv.Mat();
    const difference = new cv.Mat();
    const gray = new cv.Mat();
    const mask = new cv.Mat();
    const closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(17, 17));
    const openKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));

    try {
      cv.GaussianBlur(frame, frameBlur, new cv.Size(7, 7), 0);
      cv.GaussianBlur(this.background, backgroundBlur, new cv.Size(7, 7), 0);
      cv.absdiff(frameBlur, backgroundBlur, difference);
      cv.cvtColor(difference, gray, cv.COLOR_RGBA2GRAY);
      cv.threshold(gray, mask, this.differenceThreshold, 255, cv.THRESH_BINARY);
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, closeKernel, new cv.Point(-1, -1), 2);
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN, openKernel, new cv.Point(-1, -1), 1);
      return mask;
    } finally {
      frameBlur.delete();
      backgroundBlur.delete();
      difference.delete();
      gray.delete();
      closeKernel.delete();
      openKernel.delete();
    }
  }

  #findSheets(mask) {
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
            rectangularity,
            aspectRatio,
            corners: this.#rectangleCorners(rect),
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

  #rectangleCorners(rect) {
    const radians = (rect.angle * Math.PI) / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const halfWidth = rect.size.width / 2;
    const halfHeight = rect.size.height / 2;

    return [
      [-halfWidth, -halfHeight],
      [halfWidth, -halfHeight],
      [halfWidth, halfHeight],
      [-halfWidth, halfHeight],
    ].map(([x, y]) => ({
      x: rect.center.x + x * cosine - y * sine,
      y: rect.center.y + x * sine + y * cosine,
    }));
  }

  #processNextFrame() {
    if (!this.running || !this.capture || !this.background) return;

    const cv = globalThis.cv;
    const frame = new cv.Mat(this.height, this.width, cv.CV_8UC4);
    let mask = null;
    try {
      this.capture.read(frame);
      mask = this.#makeMask(frame);
      this.sheets = this.#findSheets(mask);
      this.onUpdate?.(this.sheets);
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
    this.background?.delete();
    this.background = null;
    this.capture = null;
    this.stream = null;
    this.video = null;
    this.sheets = [];
  }
}
