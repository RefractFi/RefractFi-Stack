import {FULLSCREEN_VERT, fullscreenTriangle, link, uniforms} from './lib/gl';
import {Spring, clamp, easeInOutSine, lerp, smoothstep} from './lib/motion';
import {prefersReducedMotion, watchVisible} from './lib/useNear';
import {LABEL, drawLabel} from './label';
import {BLUR_FRAG, COMPOSITE_FRAG, DOWN_FRAG, GEO, MAX_DROPS, MAX_WAKES, SCENE_FRAG} from './shader';

type V3 = [number, number, number];

const {A, R, D} = GEO;
const R0 = 0.455; // resting drop radius
const BODY_Y = -D + 0.085; // height of the lobe centres (the drop beads up, its foot hidden in the floor)
const ELEV = 0.98; // camera elevation (rad): steep enough that the far wall reads as a band, not a cliff
const DIST = 8;
const AIM: V3 = [0, -0.04, 0.34];
const SPAN = 4.25; // world width the framing is based on (channel + margin)
const T_TRAVEL = 0.82; // magnet, end to end (s)
const T_FLOOD = 1.6;
const T_DRAIN = 1.05;
const LEAD = {stiff: 95, damp: 13}; // lead lobe → magnet
const TRAIL = {stiff: 26, damp: 7.6}; // trailing lobe → lead lobe: the lag is the stretch
const CROWN = 0.86; // spike height under the full field
const BUMPS = 0.14; // spike height when you hover the resting drop
const LEAN = 1.05; // outward lean of the crown, per unit height
const GRAV = 14;
const DRAG_START = 5; // px
const MAX_SCALE = 1.6;
const BLOOM_DAY: V3 = [0.22, 0.26, 0.26];
const BLOOM_NIGHT: V3 = [0.3, 0.4, 0.48];

interface Drop {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  age: number;
  merge: number; // > 0: being absorbed (s)
}
interface Wake {
  x: number;
  z: number;
  age: number;
  amp: number;
}
interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}
type Uni = Record<string, WebGLUniformLocation | null>;

const SCENE_U = [
  'uRes', 'uCamPos', 'uCamR', 'uCamU', 'uCamF', 'uFocal', 'uPix', 'uTime', 'uLobeA', 'uLobeB', 'uBody', 'uSpike',
  'uLean', 'uDrop[0]', 'uDropN', 'uBoxMin', 'uBoxMax', 'uFlMin', 'uFlMax', 'uGlow', 'uCoat', 'uRipple', 'uWake[0]',
  'uLabel', 'uLabelRect', 'uDirect',
];

const cap2 = (x: number, z: number) => Math.hypot(x - clamp(x, -A, A), z) - R;
const unsettled = (s: Spring, eps = 1e-3) => Math.abs(s.x - s.target) > eps || Math.abs(s.v) > eps;

export class LodestoneEngine {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private hit: HTMLButtonElement;
  private gl: WebGL2RenderingContext | null = null;
  private pScene: WebGLProgram | null = null;
  private pDown: WebGLProgram | null = null;
  private pBlur: WebGLProgram | null = null;
  private pComp: WebGLProgram | null = null;
  private us: Uni = {};
  private ud: Uni = {};
  private ub: Uni = {};
  private uc: Uni = {};
  private vao: WebGLVertexArrayObject | null = null;
  private labelTex: WebGLTexture | null = null;
  private bloom = false;
  private T: Record<'scene' | 'a1' | 't1' | 'a2' | 't2' | 'a3' | 't3', Target> | null = null;
  private dropData = new Float32Array(MAX_DROPS * 4);
  private wakeData = new Float32Array(MAX_WAKES * 4);

  private W = 0;
  private H = 0;
  private scale = MAX_SCALE;
  private slowFrames = 0;
  private cam = {pos: [0, 0, 0] as V3, up: [0, 1, 0] as V3, fwd: [0, 0, -1] as V3, f: 3};
  private rFull = 12;

  // The magnet (where the field pulls the lead lobe) and the two lobes of the drop.
  private on = false;
  private erupted = false;
  private mag = -A;
  private tween: {from: number; to: number; t: number; delay: number; dur: number} | null = null;
  private ax = -A;
  private av = 0;
  private bx = -A;
  private bv = 0;
  private jig = new Spring(0, 170, 6.5); // squash wobble after an impact
  private sp = new Spring(0, 70, 8.5); // the crown
  private growth = 2; // crown stagger: spikes rise from the centre outward as this runs 0 → 1.45
  private hover = new Spring(0, 60, 11);
  private charge = 0; // the field switching on before the drop leaves (s left)
  private glow = new Spring(0, 48, 13);
  private front = -A - 1;
  private labelGlow = new Spring(0, 26, 9);
  private flood = {r: 0, from: 0, to: 0, t: 0, dur: 0};
  private ripple = {x: A, t: -1};
  private wakes: Wake[] = [];
  private lastWake: [number, number] | null = null;
  private drops: Drop[] = [];
  private shedCool = 0;
  private shedN = 0;
  private lean: [number, number] = [0, 0];
  private ptr: {x: number; z: number} | null = null;
  private over = false;
  private drag: {id: number; sx0: number; on: boolean; x: number} | null = null;
  private suppressClick = false;
  private dark = 0;
  private tone = '';
  private time = 0;
  private seed = 12345;

  private raf = 0;
  private last = 0;
  private odd = false;
  private visible = true;
  private alive = true;
  private reduced = prefersReducedMotion();
  private cleanups: (() => void)[] = [];

  constructor(root: HTMLElement, canvas: HTMLCanvasElement, hit: HTMLButtonElement) {
    this.root = root;
    this.canvas = canvas;
    this.hit = hit;
    this.initGL();
    this.bind();
    this.fit();
    this.writeState();
    const ro = new ResizeObserver(() => this.fit());
    ro.observe(root);
    this.cleanups.push(() => ro.disconnect());
    this.cleanups.push(
      watchVisible(root, (v) => {
        this.visible = v;
        if (v) this.start();
      }),
    );
    const sec = root.closest<HTMLElement>('.sec');
    const tone = sec?.dataset.tone;
    if (sec) this.cleanups.push(() => (sec.dataset.tone = tone));
    this.start();
  }

  destroy() {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    this.cleanups.forEach((f) => f());
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private rnd() {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }

  // ── Events ──────────────────────────────────────────────────────────────────
  private bind() {
    const {root, hit} = this;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      el.addEventListener(type, fn as EventListener);
      this.cleanups.push(() => el.removeEventListener(type, fn as EventListener));
    };
    const local = (e: PointerEvent) => {
      const r = root.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };

    on(root, 'pointermove', (e) => {
      const [sx, sy] = local(e);
      const p = this.toPlane(sx, sy);
      const hr = hit.getBoundingClientRect();
      this.over = e.clientX > hr.left - 24 && e.clientX < hr.right + 24 && e.clientY > hr.top - 24 && e.clientY < hr.bottom + 24;
      this.ptr = p ? {x: p[0], z: p[1]} : null;
      if (p && this.drag?.on) this.drag.x = clamp(p[0], -A, A);
      if (p && this.dark > 0.6 && cap2(p[0], p[1]) > 0.12 && !this.reduced) this.wake(p[0], p[1]);
      this.start();
    });
    on(root, 'pointerleave', () => {
      this.ptr = null;
      this.over = false;
      this.lastWake = null;
      this.start();
    });

    on(hit, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      this.suppressClick = false;
      this.drag = {id: e.pointerId, sx0: e.clientX, on: false, x: this.mag};
      hit.setPointerCapture(e.pointerId);
    });
    on(hit, 'pointermove', (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id || d.on) return;
      if (Math.abs(e.clientX - d.sx0) > DRAG_START) {
        d.on = true;
        hit.classList.add('is-dragging');
        this.beginDrag();
      }
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      this.drag = null;
      hit.classList.remove('is-dragging');
      if (d.on) {
        this.suppressClick = true;
        this.commit(this.mag > 0, true);
      }
    };
    on(hit, 'pointerup', end);
    on(hit, 'pointercancel', end);
    on(hit, 'click', () => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      this.commit(!this.on, false);
    });
    on(hit, 'keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const want = e.key === 'ArrowRight';
        if (want !== this.on) this.commit(want, false);
      }
    });
  }

  private wake(x: number, z: number) {
    const lw = this.lastWake;
    if (lw && Math.hypot(x - lw[0], z - lw[1]) < 0.3) return;
    this.lastWake = [x, z];
    if (this.wakes.length >= MAX_WAKES) this.wakes.shift();
    this.wakes.push({x, z, age: 0, amp: 0.22});
  }

  // ── State changes ───────────────────────────────────────────────────────────
  private atRest() {
    return !this.tween && !this.drag?.on && Math.abs(this.ax - (this.on ? A : -A)) < 0.08 && Math.abs(this.av) < 0.4;
  }

  private commit(on: boolean, fromDrag: boolean) {
    const was = this.on;
    const resting = this.atRest();
    this.on = on;
    this.shedN = 0;
    const to = on ? A : -A;
    const dur = T_TRAVEL * (0.35 + (0.65 * Math.abs(to - this.mag)) / (2 * A)) * (this.reduced ? 0.6 : 1);
    if (on) {
      let delay = 0;
      // From rest, the field switches on first: bumps rise on the drop, then it is pulled away.
      if (!fromDrag && !was && resting) {
        this.charge = 0.24;
        delay = 0.17;
      }
      this.tween = {from: this.mag, to, t: 0, delay, dur};
    } else {
      this.collapse(true);
      this.tween = {from: this.mag, to, t: 0, delay: was && !fromDrag ? 0.1 : 0, dur};
    }
    this.writeState();
    this.start();
  }

  private beginDrag() {
    this.tween = null;
    this.shedN = 0;
    this.collapse(true);
    this.start();
  }

  private collapse(fling: boolean) {
    if (fling && this.sp.x > 0.3 && !this.reduced) this.fling();
    this.erupted = false;
    this.sp.stiffness = 260;
    this.sp.damping = 30;
    this.sp.target = 0;
    if (this.flood.r > 0 || this.flood.to > 0) this.floodTo(0, T_DRAIN * Math.max(0.35, this.flood.r / this.rFull));
  }

  private erupt() {
    this.erupted = true;
    this.growth = 0;
    this.sp.stiffness = 70;
    this.sp.damping = 8.5;
    this.sp.target = 1;
    this.floodTo(this.rFull, T_FLOOD * (1 - (0.7 * this.flood.r) / this.rFull) * (this.reduced ? 0.4 : 1));
    if (!this.reduced) this.ripple = {x: this.ax, t: 0};
  }

  private floodTo(to: number, dur: number) {
    this.flood = {r: this.flood.r, from: this.flood.r, to, t: 0, dur: Math.max(0.05, dur)};
  }

  /** The spikes let go: a few tips snap off and are thrown out of the channel, to roll back to the drop. */
  private fling() {
    const n = 4 + Math.floor(this.rnd() * 2);
    for (let i = 0; i < n && this.drops.length < MAX_DROPS; i++) {
      const r = 0.035 + this.rnd() * 0.04;
      const ang = (this.rnd() - 0.5) * 2.4;
      const s = 1.0 + this.rnd() * 1.6;
      this.drops.push({
        x: this.ax + (this.rnd() - 0.3) * 0.35,
        y: 0.3 + this.rnd() * 0.45,
        z: (this.rnd() - 0.5) * 0.45,
        vx: Math.cos(ang) * s,
        vy: 1.4 + this.rnd() * 2.0,
        vz: Math.sin(ang) * s,
        r,
        age: 0,
        merge: 0,
      });
    }
  }

  private writeState() {
    const {hit, root} = this;
    hit.setAttribute('aria-checked', String(this.on));
    hit.setAttribute('aria-label', this.on ? 'After dark: on. Switch the lights back on' : 'After dark: off. Switch it on');
    root.dataset.on = String(this.on);
    if (!this.gl) this.setTone(this.on ? 1 : 0);
  }

  private setTone(dark: number) {
    const t = dark > 0.5 ? 'dark' : 'light';
    if (t === this.tone) return;
    this.tone = t;
    const sec = this.root.closest<HTMLElement>('.sec');
    if (sec) sec.dataset.tone = t;
  }

  // ── Camera ──────────────────────────────────────────────────────────────────
  private fitCamera() {
    const aspect = this.W / this.H;
    const s = Math.sin(ELEV);
    const c = Math.cos(ELEV);
    const fwd: V3 = [0, -s, -c];
    const up: V3 = [0, c, -s];
    const phi = aspect >= 1.2 ? 0.5 : lerp(0.86, 0.5, clamp((aspect - 0.55) / 0.65));
    const f = Math.min(4.6, (2 * phi * aspect * DIST) / SPAN);
    this.cam = {pos: [AIM[0] - fwd[0] * DIST, AIM[1] - fwd[1] * DIST, AIM[2] - fwd[2] * DIST], up, fwd, f};

    // The coat has to reach every corner of the view, whatever its ragged front does.
    let far = 0;
    for (const [sx, sy] of [
      [0, 0],
      [this.W, 0],
      [0, this.H],
      [this.W, this.H],
    ]) {
      const p = this.toPlane(sx, sy);
      far = Math.max(far, p ? Math.max(Math.hypot(p[0] - A, p[1]), Math.hypot(p[0] + A, p[1])) : 30);
    }
    const old = this.rFull;
    this.rFull = far * 1.42 + 0.6;
    const fl = this.flood;
    if (fl.to > 0 && Math.abs(fl.to - old) < 1e-3) {
      fl.to = this.rFull;
      if (fl.t >= fl.dur) fl.r = fl.from = this.rFull;
    }
  }

  private project(x: number, y: number, z: number): [number, number] {
    const {pos, up, fwd, f} = this.cam;
    const v = [x - pos[0], y - pos[1], z - pos[2]];
    const xc = v[0];
    const yc = v[0] * up[0] + v[1] * up[1] + v[2] * up[2];
    const zc = v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2];
    const k = (f * this.H) / 2 / zc;
    return [this.W / 2 + xc * k, this.H / 2 - yc * k];
  }

  /** Screen point → where its ray meets the surface (y = 0). */
  private toPlane(sx: number, sy: number): [number, number] | null {
    const {pos, up, fwd, f} = this.cam;
    const u = (sx - this.W / 2) / (this.H / 2);
    const v = -(sy - this.H / 2) / (this.H / 2);
    const d = [fwd[0] * f + u + up[0] * v, fwd[1] * f + up[1] * v, fwd[2] * f + up[2] * v];
    if (d[1] >= -1e-4) return null;
    const t = -pos[1] / d[1];
    return [pos[0] + d[0] * t, pos[2] + d[2] * t];
  }

  private placeHit() {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const x of [-A - R - 0.12, A + R + 0.12])
      for (const z of [-R - 0.12, LABEL.z + 0.12]) {
        const [sx, sy] = this.project(x, 0, z);
        xs.push(sx);
        ys.push(sy);
      }
    const l = Math.min(...xs);
    const t = Math.min(...ys);
    const s = this.hit.style;
    s.left = `${l.toFixed(1)}px`;
    s.top = `${t.toFixed(1)}px`;
    s.width = `${(Math.max(...xs) - l).toFixed(1)}px`;
    s.height = `${(Math.max(...ys) - t).toFixed(1)}px`;
  }

  // ── Fit ─────────────────────────────────────────────────────────────────────
  private fit() {
    const r = this.root.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.W = r.width;
    this.H = r.height;
    const s = Math.min(window.devicePixelRatio || 1, this.scale);
    const w = Math.max(1, Math.round(r.width * s));
    const h = Math.max(1, Math.round(r.height * s));
    const c = this.canvas;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      this.makeTargets();
    }
    this.fitCamera();
    this.placeHit();
    this.start();
  }

  // ── Frame ───────────────────────────────────────────────────────────────────
  private start() {
    if (!this.raf && this.alive && this.visible && this.gl) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.alive || !this.visible) return;
    const rawDt = (now - this.last) / 1000;
    const dt = Math.min(1 / 30, rawDt);
    this.last = now;
    const busy = this.update(dt);

    // Running slow while things move? Drop the render scale a notch.
    if (busy && rawDt > 0.028) {
      if (++this.slowFrames > 14 && this.scale > 0.7) {
        this.scale = Math.max(0.65, this.scale * 0.82);
        this.slowFrames = 0;
        this.fit();
      }
    } else this.slowFrames = Math.max(0, this.slowFrames - 1);

    // At rest in the dark only the crown sways: every other frame is plenty.
    const idleDark = !busy && this.on && this.erupted;
    this.odd = !this.odd;
    if (!idleDark || this.odd) this.render();
    if (busy || idleDark) this.raf = requestAnimationFrame(this.frame);
  };

  /** Advances the field, the drop, droplets, light and coat; true while anything is in motion. */
  private update(dt: number) {
    this.time += dt;
    const end = this.on ? A : -A;

    // Magnet: dragged, travelling, or resting at an end and leaning a little toward a hovering pointer.
    let magTarget = end;
    if (this.drag?.on) {
      this.mag = this.drag.x;
      magTarget = this.mag;
    } else if (this.tween) {
      const tw = this.tween;
      tw.t += dt;
      const k = clamp((tw.t - tw.delay) / tw.dur);
      this.mag = lerp(tw.from, tw.to, easeInOutSine(k));
      magTarget = this.mag;
      if (k >= 1) this.tween = null;
    } else {
      if (this.ptr && this.over) magTarget = end + clamp((this.ptr.x - end) * 0.08, this.on ? -0.16 : -0.02, this.on ? 0.02 : 0.16);
      this.mag += (magTarget - this.mag) * (1 - Math.exp(-dt * 6));
    }

    // The drop: the lead lobe follows the magnet, the trailing lobe follows the lead; the gap is the stretch.
    const lim = A + (R - R0) - 0.012;
    const n = Math.max(1, Math.ceil(dt * 240));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.av += (LEAD.stiff * (this.mag - this.ax) - LEAD.damp * this.av) * h;
      this.ax += this.av * h;
      this.bv += (TRAIL.stiff * (this.ax - this.bx) - TRAIL.damp * this.bv) * h;
      this.bx += this.bv * h;
      if (Math.abs(this.ax) > lim) {
        const s = Math.sign(this.ax);
        if (this.av * s > 0) {
          this.jig.v += Math.abs(this.av) * 2;
          this.av *= -0.15;
        }
        this.ax = s * lim;
      }
      if (Math.abs(this.bx) > lim) {
        const s = Math.sign(this.bx);
        if (this.bv * s > 0) {
          this.jig.v += Math.abs(this.bv) * 0.8;
          this.bv *= -0.1;
        }
        this.bx = s * lim;
      }
    }
    this.jig.step(dt);
    const b = this.bodyShape();

    // Crown, bumps, charge.
    this.charge = Math.max(0, this.charge - dt);
    this.hover.target = this.charge > 0 ? 1.6 : this.over && this.atRest() ? 1 : 0;
    this.hover.step(dt);
    this.sp.step(dt);
    if (this.erupted) this.growth = Math.min(1.6, this.growth + dt * 2.7);
    if (this.on && !this.erupted && !this.tween && !this.drag?.on && this.ax > A - 0.14 && this.bx > A - 0.5) this.erupt();

    // Pointer pull on the spikes (closer = stronger).
    let lx = 0;
    let lz = 0;
    if (this.ptr && (this.over || this.dark > 0.5)) {
      const dx = this.ptr.x - this.ax;
      const dz = this.ptr.z;
      const l = Math.hypot(dx, dz) || 1;
      const k = (0.3 * smoothstep(5, 0.6, l)) / l;
      lx = dx * k;
      lz = dz * k;
    }
    const lk = 1 - Math.exp(-dt * 5);
    this.lean[0] += (lx - this.lean[0]) * lk;
    this.lean[1] += (lz - this.lean[1]) * lk;

    this.updateDrops(dt, b);

    // Light: fills behind the drop (everything left of its trailing edge), all of it once the crown is up.
    const full = this.on && this.erupted;
    const fT = full ? A + 1.3 : Math.min(this.ax - b.rA * 0.2, this.bx - b.rB * 0.2);
    this.front += (fT - this.front) * (1 - Math.exp(-dt * (full ? 2.6 : 28)));
    this.glow.target = this.on || (this.drag?.on && this.mag > -A + 0.25) ? 1 : 0;
    this.glow.step(dt);
    this.labelGlow.target = full ? 1 : 0;
    this.labelGlow.step(dt);

    // The coat floods out ahead of the room going dark, and drains back toward the drop.
    const f = this.flood;
    if (f.t < f.dur) {
      f.t += dt;
      const k = clamp(f.t / f.dur);
      f.r = lerp(f.from, f.to, f.to > f.from ? 1 - (1 - k) ** 2 : easeInOutSine(k));
    }
    this.dark = smoothstep(0.1, 0.62, f.r / this.rFull);
    this.setTone(this.dark);
    if (this.ripple.t >= 0) {
      this.ripple.t += dt;
      if (this.ripple.t > 8 || this.dark < 0.05) this.ripple.t = -1;
    }
    for (const w of this.wakes) w.age += dt;
    this.wakes = this.wakes.filter((w) => w.age < 2.2);

    return (
      !!this.tween ||
      !!this.drag ||
      Math.abs(this.av) + Math.abs(this.bv) > 0.002 ||
      Math.abs(this.ax - this.bx) > 0.0015 ||
      Math.abs(this.mag - magTarget) > 0.001 ||
      Math.abs(this.ax - this.mag) > 0.001 ||
      unsettled(this.jig) ||
      unsettled(this.sp) ||
      unsettled(this.hover) ||
      unsettled(this.glow) ||
      unsettled(this.labelGlow) ||
      (this.erupted && this.growth < 1.6) ||
      Math.abs(this.front - fT) > 0.002 ||
      Math.abs(this.lean[0] - lx) + Math.abs(this.lean[1] - lz) > 0.001 ||
      f.t < f.dur ||
      this.charge > 0 ||
      this.drops.length > 0 ||
      this.ripple.t >= 0 ||
      this.wakes.length > 0
    );
  }

  private bodyShape() {
    const sep = Math.abs(this.ax - this.bx);
    const s = clamp(sep / 1.4);
    const j = clamp(this.jig.x, -0.6, 0.6);
    const crown = clamp(this.sp.x, 0, 1);
    return {
      sep,
      rA: R0 * (1 - 0.12 * s) * (1 + 0.05 * j),
      rB: R0 * (1 - 0.5 * s) * (1 + 0.05 * j),
      sy: (1 - 0.42 * s) * (1 - 0.16 * j) * lerp(1, 0.72, crown),
      shiver: 0.012 * clamp(Math.abs(this.av) / 3) + 0.005 * Math.abs(j),
    };
  }

  private updateDrops(dt: number, b: ReturnType<LodestoneEngine['bodyShape']>) {
    // A fast, stretched tail sheds droplets that lag behind and roll back in.
    this.shedCool -= dt;
    if (Math.abs(this.bv) > 1.4 && b.sep > 0.5 && this.shedCool <= 0 && this.shedN < 3 && this.drops.length < MAX_DROPS && !this.reduced) {
      const dir = Math.sign(this.bv);
      const r = 0.038 + this.rnd() * 0.034;
      this.drops.push({
        x: this.bx - dir * b.rB * 0.8,
        y: -D + r * 0.82,
        z: (this.rnd() - 0.5) * 0.24,
        vx: this.bv * 0.18,
        vy: 0,
        vz: (this.rnd() - 0.5) * 0.25,
        r,
        age: 0,
        merge: 0,
      });
      this.shedCool = 0.11 + this.rnd() * 0.08;
      this.shedN++;
    }

    for (const d of this.drops) {
      d.age += dt;
      if (d.merge > 0) {
        d.merge += dt;
        continue;
      }
      const below = d.y < -0.005; // in the channel: the walls hold it
      const floorNow = (below || cap2(d.x, d.z) < -d.r * 0.3 ? -D : 0) + d.r * 0.82;
      if (d.y <= floorNow + 0.004) {
        // Grounded: the magnet pulls it home along the surface, against rolling friction.
        const dx = this.ax - d.x;
        const dz = -d.z;
        const l = Math.hypot(dx, dz) || 1;
        const pull = 4.2 / (1 + 0.25 * l);
        d.vx += (dx / l) * pull * dt;
        d.vz += (dz / l) * pull * dt;
        const fr = Math.exp(-(below ? 2.0 : 2.6) * dt);
        d.vx *= fr;
        d.vz *= fr;
      }
      d.vy -= GRAV * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      if (below) {
        const cx = clamp(d.x, -A, A);
        const ox = d.x - cx;
        const l = Math.hypot(ox, d.z);
        const m = R - d.r;
        if (l > m) {
          const nx = ox / l;
          const nz = d.z / l;
          d.x = cx + nx * m;
          d.z = nz * m;
          const vn = d.vx * nx + d.vz * nz;
          if (vn > 0) {
            d.vx -= 1.4 * vn * nx;
            d.vz -= 1.4 * vn * nz;
          }
        }
      }
      const fy = (below || cap2(d.x, d.z) < -d.r * 0.3 ? -D : 0) + d.r * 0.82;
      if (d.y < fy) {
        d.y = fy;
        d.vy = d.vy < -1.2 ? -d.vy * 0.28 : 0;
      }
      if (d.age > 0.3 && d.y < 0.05) {
        const near = (x: number, r: number) => Math.hypot(d.x - x, d.z) < r * 0.75 + d.r * 0.3;
        if (near(this.ax, b.rA) || near(this.bx, b.rB)) {
          d.merge = 1e-4;
          this.jig.v += 0.35;
        }
      }
      if (d.age > 9) d.merge = 1e-4;
    }
    this.drops = this.drops.filter((d) => d.merge < 0.12);
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  private render() {
    const gl = this.gl;
    if (!gl || !this.pScene) return;
    const c = this.canvas;
    const T = this.bloom ? this.T : null;
    const b = this.bodyShape();
    const crown = clamp(this.sp.x, 0, 1.3);
    const hv = clamp(this.hover.x, 0, 1.6);
    const spikeH = crown > 0.01 ? CROWN * crown * (1 + 0.07 * hv) : 0;
    const bumps = BUMPS * hv * (1 - clamp(crown * 4));
    const H = Math.max(spikeH, bumps);
    const growth = spikeH >= bumps ? this.growth : 2;
    const sway = 0.045 * clamp(crown);

    // Bounds: the fluid's own box (drop, crown, droplets), and that ∪ the channel for the march.
    const fl = [Math.min(this.ax - b.rA, this.bx - b.rB), -D - 0.02, -R0, Math.max(this.ax + b.rA, this.bx + b.rB), BODY_Y + b.sy * R0 * 1.05, R0];
    if (H > 0.006) {
      const reach = b.rA * (1 + LEAN * H) + (Math.hypot(this.lean[0], this.lean[1]) + sway) * H + 0.06;
      fl[0] = Math.min(fl[0], this.ax - reach);
      fl[3] = Math.max(fl[3], this.ax + reach);
      fl[2] = Math.min(fl[2], -reach);
      fl[5] = Math.max(fl[5], reach);
      fl[4] = Math.max(fl[4], BODY_Y + b.sy * b.rA + H + 0.02);
    }
    const drops = this.drops.slice(0, MAX_DROPS);
    drops.forEach((d, i) => {
      const r = d.r * Math.min(1, d.age / 0.06) * (d.merge > 0 ? 1 - d.merge / 0.12 : 1);
      this.dropData.set([d.x, d.y, d.z, r], i * 4);
      fl[0] = Math.min(fl[0], d.x - d.r);
      fl[1] = Math.min(fl[1], d.y - d.r);
      fl[2] = Math.min(fl[2], d.z - d.r);
      fl[3] = Math.max(fl[3], d.x + d.r);
      fl[4] = Math.max(fl[4], d.y + d.r);
      fl[5] = Math.max(fl[5], d.z + d.r);
    });
    for (let i = 0; i < 3; i++) {
      fl[i] -= 0.04;
      fl[i + 3] += 0.04;
    }
    const box = [
      Math.min(fl[0], -A - R - 0.02),
      Math.min(fl[1], -D - 0.02),
      Math.min(fl[2], -R - 0.02),
      Math.max(fl[3], A + R + 0.02),
      Math.max(fl[4], 0.015),
      Math.max(fl[5], R + 0.02),
    ];
    this.wakeData.fill(0);
    this.wakes.forEach((w, i) => this.wakeData.set([w.x, w.z, w.age, w.amp], i * 4));

    gl.bindFramebuffer(gl.FRAMEBUFFER, T ? T.scene.fb : null);
    gl.viewport(0, 0, c.width, c.height);
    gl.useProgram(this.pScene);
    const u = this.us;
    const {pos, up, fwd, f} = this.cam;
    gl.uniform2f(u.uRes, c.width, c.height);
    gl.uniform3fv(u.uCamPos, pos);
    gl.uniform3f(u.uCamR, 1, 0, 0);
    gl.uniform3fv(u.uCamU, up);
    gl.uniform3fv(u.uCamF, fwd);
    gl.uniform1f(u.uFocal, f);
    gl.uniform1f(u.uPix, 1 / (f * 0.5 * c.height));
    gl.uniform1f(u.uTime, this.time);
    gl.uniform3f(u.uLobeA, this.ax, 0, b.rA);
    gl.uniform3f(u.uLobeB, this.bx, 0, b.rB);
    gl.uniform4f(u.uBody, BODY_Y, b.sy, 0, b.shiver);
    gl.uniform4f(u.uSpike, H, growth, LEAN, sway);
    gl.uniform2f(u.uLean, this.lean[0], this.lean[1]);
    gl.uniform4fv(u['uDrop[0]'], this.dropData);
    gl.uniform1i(u.uDropN, drops.length);
    gl.uniform3f(u.uBoxMin, box[0], box[1], box[2]);
    gl.uniform3f(u.uBoxMax, box[3], box[4], box[5]);
    gl.uniform3f(u.uFlMin, fl[0], fl[1], fl[2]);
    gl.uniform3f(u.uFlMax, fl[3], fl[4], fl[5]);
    gl.uniform4f(u.uGlow, clamp(this.glow.x), this.front, clamp(this.labelGlow.x), this.dark);
    const fr = this.flood.r;
    gl.uniform4f(u.uCoat, this.ax, 0, fr > 0.02 ? fr : 0, fr >= this.rFull - 1e-3 ? 1 : 0);
    const rt = this.ripple.t;
    gl.uniform4f(u.uRipple, this.ripple.x, 0, Math.max(rt, 0), rt >= 0 ? 0.32 * Math.exp(-0.5 * rt) * smoothstep(0, 0.12, rt) : 0);
    gl.uniform4fv(u['uWake[0]'], this.wakeData);
    gl.uniform4f(u.uLabelRect, LABEL.x0, LABEL.z - LABEL.depth / 2, 1 / (LABEL.x1 - LABEL.x0), 1 / LABEL.depth);
    gl.uniform1f(u.uDirect, T ? 0 : 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.labelTex);
    gl.uniform1i(u.uLabel, 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!T) return;

    this.down(T.scene, T.a1, 0.9);
    this.blur(T.a1, T.t1, 1, 0);
    this.blur(T.t1, T.a1, 0, 1);
    this.down(T.a1, T.a2, 0);
    this.blur(T.a2, T.t2, 1, 0);
    this.blur(T.t2, T.a2, 0, 1);
    this.down(T.a2, T.a3, 0);
    this.blur(T.a3, T.t3, 1, 0);
    this.blur(T.t3, T.a3, 0, 1);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, c.width, c.height);
    gl.useProgram(this.pComp);
    [T.scene, T.a1, T.a2, T.a3].forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
    });
    gl.uniform1i(this.uc.uScene, 0);
    gl.uniform1i(this.uc.uB1, 1);
    gl.uniform1i(this.uc.uB2, 2);
    gl.uniform1i(this.uc.uB3, 3);
    gl.uniform2f(this.uc.uRes, c.width, c.height);
    const k = this.dark;
    gl.uniform3f(this.uc.uBloomK, lerp(BLOOM_DAY[0], BLOOM_NIGHT[0], k), lerp(BLOOM_DAY[1], BLOOM_NIGHT[1], k), lerp(BLOOM_DAY[2], BLOOM_NIGHT[2], k));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private down(src: Target, dst: Target, thresh: number) {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.useProgram(this.pDown);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(this.ud.uSrc, 0);
    gl.uniform2f(this.ud.uSrcTexel, 1 / src.w, 1 / src.h);
    gl.uniform2f(this.ud.uDst, dst.w, dst.h);
    gl.uniform1f(this.ud.uThresh, thresh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private blur(src: Target, dst: Target, dx: number, dy: number) {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.useProgram(this.pBlur);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(this.ub.uSrc, 0);
    gl.uniform2f(this.ub.uDir, dx / src.w, dy / src.h);
    gl.uniform2f(this.ub.uDst, dst.w, dst.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ── GL ──────────────────────────────────────────────────────────────────────
  private initGL() {
    const c = this.canvas;
    const gl = c.getContext('webgl2', {antialias: false, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance'});
    if (!gl) {
      this.root.classList.add('ld--flat');
      return;
    }
    const scene = link(gl, FULLSCREEN_VERT, SCENE_FRAG, ['aPos'], 'lodestone');
    if (!scene) {
      this.root.classList.add('ld--flat');
      return;
    }
    this.gl = gl;
    this.pScene = scene;
    this.us = uniforms(gl, scene, SCENE_U);
    this.vao = fullscreenTriangle(gl);
    if (gl.getExtension('EXT_color_buffer_float')) {
      this.pDown = link(gl, FULLSCREEN_VERT, DOWN_FRAG, ['aPos'], 'lodestone-down');
      this.pBlur = link(gl, FULLSCREEN_VERT, BLUR_FRAG, ['aPos'], 'lodestone-blur');
      this.pComp = link(gl, FULLSCREEN_VERT, COMPOSITE_FRAG, ['aPos'], 'lodestone-comp');
      this.bloom = !!(this.pDown && this.pBlur && this.pComp);
      if (this.bloom) {
        this.ud = uniforms(gl, this.pDown!, ['uSrc', 'uSrcTexel', 'uDst', 'uThresh']);
        this.ub = uniforms(gl, this.pBlur!, ['uSrc', 'uDir', 'uDst']);
        this.uc = uniforms(gl, this.pComp!, ['uScene', 'uB1', 'uB2', 'uB3', 'uRes', 'uBloomK']);
      }
    }

    this.labelTex = gl.createTexture();
    this.uploadLabel();
    // Redraw the label once Satoshi has arrived.
    document.fonts?.load('500 60px Satoshi').then(() => {
      if (this.alive && this.gl) {
        this.uploadLabel();
        this.render();
      }
    });

    const lost = (e: Event) => {
      e.preventDefault();
      this.pScene = null;
      this.T = null;
    };
    const restored = () => {
      this.initGL();
      this.makeTargets();
      this.start();
    };
    c.addEventListener('webglcontextlost', lost);
    c.addEventListener('webglcontextrestored', restored);
    this.cleanups.push(() => {
      c.removeEventListener('webglcontextlost', lost);
      c.removeEventListener('webglcontextrestored', restored);
    });
  }

  private uploadLabel() {
    const gl = this.gl;
    if (!gl || !this.labelTex) return;
    gl.bindTexture(gl.TEXTURE_2D, this.labelTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, drawLabel());
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const an = gl.getExtension('EXT_texture_filter_anisotropic');
    if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(an.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }

  private makeTargets() {
    const gl = this.gl;
    if (!gl || !this.bloom) return;
    if (this.T) {
      for (const t of Object.values(this.T)) {
        gl.deleteFramebuffer(t.fb);
        gl.deleteTexture(t.tex);
      }
      this.T = null;
    }
    const mk = (w: number, h: number): Target => {
      w = Math.max(1, Math.ceil(w));
      h = Math.max(1, Math.ceil(h));
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return {fb, tex, w, h};
    };
    const {width: w, height: h} = this.canvas;
    const scene = mk(w, h);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(scene.fb);
      gl.deleteTexture(scene.tex);
      this.bloom = false;
      return;
    }
    this.T = {
      scene,
      a1: mk(w / 4, h / 4),
      t1: mk(w / 4, h / 4),
      a2: mk(w / 8, h / 8),
      t2: mk(w / 8, h / 8),
      a3: mk(w / 16, h / 16),
      t3: mk(w / 16, h / 16),
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
