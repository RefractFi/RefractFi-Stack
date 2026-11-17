import {GEO} from './shader';

/** The printed row in front of the channel, in world units on the surface (z toward the camera). */
export const LABEL = {text: 'AFTER DARK', x0: -2.3, x1: 2.3, z: 0.96, depth: 0.42};

const W = 2048;

/**
 * One texture, three channels so the shader can light them separately: R = the words, G = the sun (left end,
 * dims at night), B = the crescent (right end, glows with the words).
 */
export function drawLabel(): HTMLCanvasElement {
  const ppu = W / (LABEL.x1 - LABEL.x0);
  const H = Math.round(LABEL.depth * ppu);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'lighter';
  const X = (x: number) => (x - LABEL.x0) * ppu;
  const cy = H / 2;

  // Words: wide-tracked caps, drawn a letter at a time so the tracking doesn't depend on ctx.letterSpacing.
  const size = 0.125 * ppu;
  g.font = `500 ${size.toFixed(1)}px Satoshi, Inter, system-ui, sans-serif`;
  g.fillStyle = 'rgb(255,0,0)';
  g.textBaseline = 'alphabetic';
  const chars = [...LABEL.text];
  const track = size * 0.44;
  const widths = chars.map((ch) => g.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + track * (chars.length - 1);
  let x = X(0) - total / 2;
  const base = cy + size * 0.35; // cap height ≈ 0.7 em, centred
  chars.forEach((ch, i) => {
    g.fillText(ch, x, base);
    x += widths[i] + track;
  });

  // Sun: a dot and eight short rays, under the left end of the channel.
  const sx = X(-GEO.A);
  g.fillStyle = 'rgb(0,255,0)';
  g.strokeStyle = 'rgb(0,255,0)';
  g.beginPath();
  g.arc(sx, cy, 0.021 * ppu, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 0.0085 * ppu;
  g.lineCap = 'round';
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.beginPath();
    g.moveTo(sx + Math.cos(a) * 0.036 * ppu, cy + Math.sin(a) * 0.036 * ppu);
    g.lineTo(sx + Math.cos(a) * 0.055 * ppu, cy + Math.sin(a) * 0.055 * ppu);
    g.stroke();
  }

  // Crescent: a disc with an offset disc cut out, under the right end.
  const r = 0.05 * ppu;
  const m = document.createElement('canvas');
  m.width = m.height = Math.ceil(r * 2 + 8);
  const mg = m.getContext('2d')!;
  const mc = m.width / 2;
  mg.fillStyle = 'rgb(0,0,255)';
  mg.beginPath();
  mg.arc(mc, mc, r, 0, Math.PI * 2);
  mg.fill();
  mg.globalCompositeOperation = 'destination-out';
  mg.beginPath();
  mg.arc(mc + r * 0.46, mc - r * 0.28, r * 0.84, 0, Math.PI * 2);
  mg.fill();
  g.drawImage(m, X(GEO.A) - mc, cy - mc);
  return c;
}
