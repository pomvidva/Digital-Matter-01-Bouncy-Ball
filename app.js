import { SheetDetector } from "./sheet_detector.js";

const status = document.querySelector("#status");
const video = document.querySelector("#camera-feed");
const canvas = document.querySelector("#overlay");
const ctx = canvas.getContext("2d");
let detector;

function drawDetectedSheets(sheets) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#00ff66";
  ctx.lineWidth = 3;
  ctx.fillStyle = "#00ff66";
  ctx.font = "16px sans-serif";

  for (const sheet of sheets) {
    const points = sheet.corners;

    if (points && points.length >= 4) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.closePath();
      ctx.stroke();

      const labelX = points[0].x;
      const labelY = Math.min(points[0].y, points[1].y, points[2].y, points[3].y) - 8;
      ctx.fillText("Sheet", labelX, Math.max(labelY, 16));
      continue;
    }

    if (sheet.center && sheet.size) {
      const x = sheet.center.x - sheet.size.width / 2;
      const y = sheet.center.y - sheet.size.height / 2;
      ctx.strokeRect(x, y, sheet.size.width, sheet.size.height);
      ctx.fillText("Sheet", x, Math.max(y - 8, 16));
    }
  }
}

window.addEventListener("opencv-ready", async () => {
  detector = new SheetDetector({
    camera: "user",
    width: 1280,
    height: 720,
    minArea: 2000,
    threshold: 25,

    onUpdate(sheets) {
      status.textContent = `ตรวจพบ ${sheets.length} แผ่น`;
      drawDetectedSheets(sheets);

      if (sheets.length > 0) {
        console.log(sheets);
      }
    }
  });

  try {
    status.textContent = "กรุณานำแผ่นทั้งหมดออกจากกำแพง";
    await detector.start();

    if (video && detector.video) {
      video.srcObject = detector.stream;
      video.width = detector.width;
      video.height = detector.height;
      canvas.width = detector.width;
      canvas.height = detector.height;
    }

    status.textContent = "เริ่มตรวจจับแล้ว";
  } catch (error) {
    status.textContent = `เปิดกล้องไม่สำเร็จ: ${error.message}`;
    console.error(error);
  }
});