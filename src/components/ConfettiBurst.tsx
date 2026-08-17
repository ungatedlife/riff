import { useEffect, useRef } from "react";

/// The publish celebration: the room explodes into a shower of confetti
/// that arcs, tumbles, and fades — then `onDone` fires and the room can
/// return the writer to wherever they were before the riff.
///
/// Dependency-free canvas animation; honors prefers-reduced-motion by
/// skipping straight to `onDone` after a beat.

const DURATION_MS = 2200;
const FADE_START = 0.55; // fraction of lifetime after which a particle fades
const PARTICLE_COUNT = 220;
const REDUCED_MOTION_PAUSE_MS = 600;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  angle: number;
  spin: number;
  color: string;
  /** Phase offset for the flutter wobble. */
  flutter: number;
  bornAt: number;
  lifeMs: number;
}

function themeColor(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return raw ? `rgb(${raw.split(/\s+/).join(", ")})` : fallback;
}

function makeParticles(width: number, height: number, now: number): Particle[] {
  const palette = [
    themeColor("--color-coral", "rgb(232, 112, 95)"),
    themeColor("--color-coral-dark", "rgb(214, 96, 79)"),
    "#f5c04e", // gold
    "#7fc8a9", // celebration green
    "#6ea8dc", // sky
    "#ffffff",
  ];

  const cx = width / 2;
  const cy = height * 0.45; // the burst origin sits where the "published" mark shows
  const particles: Particle[] = [];

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    // Radial explosion with an upward bias — more firework than fountain.
    const theta = Math.random() * Math.PI * 2;
    const power = 6 + Math.random() * 13;
    particles.push({
      x: cx + (Math.random() - 0.5) * 60,
      y: cy + (Math.random() - 0.5) * 40,
      vx: Math.cos(theta) * power,
      vy: Math.sin(theta) * power - 6,
      w: 5 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.35,
      color: palette[i % palette.length],
      flutter: Math.random() * Math.PI * 2,
      bornAt: now,
      lifeMs: DURATION_MS * (0.7 + Math.random() * 0.3),
    });
  }
  return particles;
}

export default function ConfettiBurst({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      onDoneRef.current();
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const timer = window.setTimeout(finish, REDUCED_MOTION_PAUSE_MS);
      return () => window.clearTimeout(timer);
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      finish();
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const start = performance.now();
    let particles = makeParticles(width, height, start);
    let raf = 0;

    const step = (now: number) => {
      ctx.clearRect(0, 0, width, height);

      particles = particles.filter((p) => now - p.bornAt < p.lifeMs);
      for (const p of particles) {
        const age = (now - p.bornAt) / p.lifeMs;
        p.vy += 0.22; // gravity
        p.vx *= 0.985; // drag
        p.vy *= 0.985;
        p.x += p.vx + Math.sin(now / 140 + p.flutter) * 0.8;
        p.y += p.vy;
        p.angle += p.spin;

        ctx.save();
        ctx.globalAlpha =
          age < FADE_START ? 1 : Math.max(0, 1 - (age - FADE_START) / (1 - FADE_START));
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        // Vertical squash fakes a 3D tumble as the piece flips over.
        ctx.scale(1, 0.35 + 0.65 * Math.abs(Math.sin(now / 120 + p.flutter)));
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }

      if (particles.length === 0 || now - start > DURATION_MS + 400) {
        finish();
        return;
      }
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 w-full h-full pointer-events-none z-[300]"
      aria-hidden="true"
    />
  );
}
