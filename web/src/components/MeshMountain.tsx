import { useEffect, useRef } from "react";

/**
 * Animated wireframe "mesh mountain" for the header, after the mockup: a glowing blue grid surface
 * with two peaks that slowly breathe, ripple and sway. Pure canvas, no dependencies.
 * Honors prefers-reduced-motion (renders one still frame) and pauses when off-screen.
 */
const COLS = 54;
const ROWS = 20;
const FPS = 30;

interface Peak { x: number; z: number; h: number; w: number }
const PEAKS: Peak[] = [
  { x: -0.2, z: 0.55, h: 0.9, w: 0.15 },
  { x: 0.22, z: 0.42, h: 1.15, w: 0.13 },
  { x: 0.52, z: 0.7, h: 0.5, w: 0.14 },
  { x: -0.62, z: 0.62, h: 0.3, w: 0.2 },
];

function height(x: number, z: number, t: number): number {
  let y = 0;
  for (let i = 0; i < PEAKS.length; i++) {
    const p = PEAKS[i];
    const breathe = 1 + 0.12 * Math.sin(t * 0.6 + i * 1.7);
    const dx = x - p.x - 0.03 * Math.sin(t * 0.25 + i);
    const dz = z - p.z;
    y += p.h * breathe * Math.exp(-(dx * dx + dz * dz) / (2 * p.w * p.w));
  }
  // travelling ripple across the surface
  y += 0.06 * Math.sin(x * 9 - t * 1.4) * Math.cos(z * 7 + t * 0.9);
  return y;
}

export default function MeshMountain({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = 0;
    let visible = true;
    let w = 0;
    let h = 0;
    const pts = new Float32Array(COLS * ROWS * 3); // screen x, y, brightness
    let palette = { line: "56, 189, 248", dot: "186, 230, 253", blend: "lighter" as GlobalCompositeOperation };
    let paletteAt = -1e9;
    const readPalette = (time: number) => {
      if (time - paletteAt < 500) return;
      paletteAt = time;
      const cs = getComputedStyle(canvas);
      palette = {
        line: cs.getPropertyValue("--mesh-rgb").trim() || palette.line,
        dot: cs.getPropertyValue("--mesh-dot-rgb").trim() || palette.dot,
        blend: (cs.getPropertyValue("--mesh-blend").trim() || "lighter") as GlobalCompositeOperation,
      };
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (time: number) => {
      const t = time / 1000;
      readPalette(time);
      ctx.clearRect(0, 0, w, h);
      if (!w || !h) return;
      const yaw = 0.18 * Math.sin(t * 0.15);
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const camDist = 1.6;
      const horizon = h * 1.02;
      const scale = w * 0.62;
      const lift = h * 0.74;

      for (let r = 0; r < ROWS; r++) {
        const z0 = r / (ROWS - 1);
        for (let c = 0; c < COLS; c++) {
          const x0 = (c / (COLS - 1)) * 2 - 1;
          const y = height(x0, z0, t);
          // rotate around vertical axis, then perspective-project
          const x = x0 * cosY - (z0 - 0.5) * sinY;
          const z = x0 * sinY + (z0 - 0.5) * cosY + 0.5;
          const persp = camDist / (camDist + z);
          const i = (r * COLS + c) * 3;
          pts[i] = w / 2 + x * scale * persp;
          pts[i + 1] = horizon - (y * lift + z * h * 0.34) * persp;
          // fade toward the left/right ends and the back rows; peaks glow brighter
          const edge = Math.max(0, 1 - Math.pow(Math.abs(x0), 2.4));
          pts[i + 2] = edge * (0.25 + 0.75 * Math.min(1, y / 1.1)) * (0.55 + 0.45 * (1 - z0));
        }
      }

      ctx.globalCompositeOperation = palette.blend;
      ctx.lineCap = "round";
      const line = (a: number, b: number, width: number, alphaMul: number) => {
        const ia = a * 3;
        const ib = b * 3;
        const alpha = ((pts[ia + 2] + pts[ib + 2]) / 2) * alphaMul;
        if (alpha < 0.02) return;
        ctx.strokeStyle = `rgba(${palette.line}, ${alpha.toFixed(3)})`;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(pts[ia], pts[ia + 1]);
        ctx.lineTo(pts[ib], pts[ib + 1]);
        ctx.stroke();
      };
      // two passes: a soft wide glow, then the crisp wire
      for (const [width, mul] of [[3, 0.22], [0.9, 1.0]] as const) {
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            const k = r * COLS + c;
            if (c < COLS - 1) line(k, k + 1, width, mul);
            if (r < ROWS - 1) line(k, k + COLS, width, mul * 0.8);
          }
        }
      }
      // twinkling vertices on the brightest ridges
      for (let k = 0; k < COLS * ROWS; k++) {
        const b = pts[k * 3 + 2];
        if (b < 0.55) continue;
        const tw = 0.5 + 0.5 * Math.sin(t * 3 + k * 1.3);
        ctx.fillStyle = `rgba(${palette.dot}, ${(b * tw * 0.9).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(pts[k * 3], pts[k * 3 + 1], 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
    };

    const loop = (time: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || time - last < 1000 / FPS) return;
      last = time;
      draw(time);
    };

    resize();
    const ro = new ResizeObserver(() => {
      resize();
      draw(performance.now());
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
    io.observe(canvas);
    if (reduced) draw(4000);
    else raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
