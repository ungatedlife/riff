import { useEffect, useRef } from 'react';

/** Bricks' woven paper recipe, rendered once at 2x and tiled as a neutral overlay. */
export default function Paper() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
    const ctx = canvas.getContext('2d'); if (!ctx || !ref.current) return;
    let seed = 0xB121C5;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const weave = (horizontal: boolean, count: number, min: number, max: number, width: number, alpha: number) => {
      for (let i = 0; i < count; i++) {
        const along = random() * 512, across = random() * 512, length = min + random() * (max - min);
        const ink = random() > 0.5 ? '255,255,255' : '0,0,0';
        ctx.fillStyle = `rgba(${ink},${alpha * (0.35 + random() * 0.65)})`;
        for (const dx of [-512, 0, 512]) for (const dy of [-512, 0, 512])
          ctx.fillRect((horizontal ? along : across) + dx, (horizontal ? across : along) + dy, horizontal ? length : width, horizontal ? width : length);
      }
    };
    weave(true, 3200, 12, 58, 1, 0.3); weave(false, 3200, 12, 58, 1, 0.3);
    weave(true, 520, 30, 120, 2, 0.17); weave(false, 520, 30, 120, 2, 0.17);
    ref.current.style.backgroundImage = `url(${canvas.toDataURL()})`;
  }, []);
  return <div ref={ref} className="paper-weave" aria-hidden="true" />;
}
