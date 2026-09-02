import { useEffect, useRef } from "react";
import type { Snapshot } from "./useGame";
import type { Side } from "./protocol";

const W = 800, H = 480, PADDLE_W = 12, PADDLE_H = 80, PADDLE_X = 24, BALL_R = 8;
const SNAPSHOT_MS = 1000 / 30; // server broadcast interval

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Canvas renderer. It draws ONLY what the server sent - it never simulates the
 * ball itself. Its one piece of cleverness is interpolating between the last
 * two snapshots so 30 updates per second look like smooth 60 fps motion.
 */
export function Field({
  snaps, side,
}: {
  snaps: React.MutableRefObject<{ prev: Snapshot | null; curr: Snapshot | null }>;
  side: Side | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { prev, curr } = snaps.current;

      ctx.fillStyle = "#0b0f14";
      ctx.fillRect(0, 0, W, H);

      // centre line
      ctx.strokeStyle = "#1e293b";
      ctx.lineWidth = 3;
      ctx.setLineDash([12, 14]);
      ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
      ctx.setLineDash([]);

      if (!curr) return;
      // How far we are through the interval since `curr` arrived (0..1).
      const t = prev ? Math.min(1, (performance.now() - curr.at) / SNAPSHOT_MS) : 1;
      const base = prev ?? curr;

      const bx = lerp(base.ball[0], curr.ball[0], t);
      const by = lerp(base.ball[1], curr.ball[1], t);
      const ly = lerp(base.paddles[0], curr.paddles[0], t);
      const ry = lerp(base.paddles[1], curr.paddles[1], t);

      // paddles - yours is highlighted
      ctx.fillStyle = side === "left" ? "#38bdf8" : "#64748b";
      ctx.fillRect(PADDLE_X, ly, PADDLE_W, PADDLE_H);
      ctx.fillStyle = side === "right" ? "#38bdf8" : "#64748b";
      ctx.fillRect(W - PADDLE_X - PADDLE_W, ry, PADDLE_W, PADDLE_H);

      // ball
      ctx.fillStyle = "#f8fafc";
      ctx.beginPath(); ctx.arc(bx, by, BALL_R, 0, Math.PI * 2); ctx.fill();

      // score
      ctx.fillStyle = "#334155";
      ctx.font = "bold 64px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(String(curr.score[0]), W / 2 - 70, 76);
      ctx.fillText(String(curr.score[1]), W / 2 + 70, 76);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [snaps, side]);

  return <canvas ref={ref} width={W} height={H} className="field" />;
}
