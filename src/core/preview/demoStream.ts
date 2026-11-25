/**
 * A moving test pattern as a MediaStream, so the demo server can show a "playing" preview that goes
 * through the same <video> path as a real one.
 */
export function createDemoStream(label: string): { stream: MediaStream; stop: () => void } {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d")!;
  const bars = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
  let frame = 0;
  const draw = () => {
    const w = canvas.width / bars.length;
    bars.forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.fillRect(i * w, 0, w, canvas.height * 0.75);
    });
    ctx.fillStyle = "#111";
    ctx.fillRect(0, canvas.height * 0.75, canvas.width, canvas.height * 0.25);
    ctx.fillStyle = "#fff";
    ctx.fillRect(((frame * 4) % (canvas.width - 30)) + 10, canvas.height * 0.8, 10, canvas.height * 0.15);
    ctx.font = "bold 20px sans-serif";
    ctx.fillText(`${label} · DEMO`, 14, 28);
    frame += 1;
  };
  draw();
  const timer = setInterval(draw, 66);
  const stream = canvas.captureStream(15);
  return { stream, stop: () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); } };
}
