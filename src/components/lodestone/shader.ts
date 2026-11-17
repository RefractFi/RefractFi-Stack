import {NOISE_GLSL} from './lib/gl';

/** Channel geometry in world units, shared with the engine: half straight length, radius, depth. */
export const GEO = {A: 1.55, R: 0.5, D: 0.3};
export const MAX_DROPS = 8;
export const MAX_WAKES = 6;

/**
 * The switch, raymarched. World: y up, the surface is the plane y = 0 with a stadium-shaped channel cut into it
 * along x (rounded lip, cove where wall meets floor); the camera looks down at it from the front (+z).
 *
 * Ferrofluid = the drop (convex hull of two squashed lobes, so it stretches into a slug when the trailing lobe
 * lags), droplets (spheres, smooth-unioned so they neck into the drop), and the spike crown: round cones on an
 * equilateral lattice over the lead lobe, leaning outward (uSpike.z) and toward the pointer (uLean). The three
 * nearest lattice points are found after un-shearing the lean, so only three cones are evaluated per sample.
 *
 * The surface: matte chalk (key light from behind-left so the far wall of the channel sits in shadow, soft
 * shadows + AO inside the channel), printed label (texture), the black coat that floods out over it (noisy
 * radial front + splash drops + meniscus highlight, eruption rings and pointer wakes in its normal), and the
 * channel's blacklight glow (fills behind the drop: everything left of uGlow.y) with spill onto the lip and
 * surroundings. Rays that skim within a pixel of the fluid darken the surface behind them (silhouette AA).
 * Output is linear HDR for the bloom passes, or tone-mapped directly when float targets are missing.
 */
export const SCENE_FRAG = /* glsl */ `#version 300 es
precision highp float;
#define MAX_DROPS ${MAX_DROPS}
#define MAX_WAKES ${MAX_WAKES}

uniform vec2 uRes;
uniform vec3 uCamPos;
uniform vec3 uCamR;
uniform vec3 uCamU;
uniform vec3 uCamF;
uniform float uFocal;
uniform float uPix;      // radians per pixel
uniform float uTime;
uniform vec3 uLobeA;     // lead lobe: x, z, radius
uniform vec3 uLobeB;     // trailing lobe
uniform vec4 uBody;      // lobe centre height, vertical squash, -, surface shiver
uniform vec4 uSpike;     // height, growth (staggered from the centre out), outward lean, sway
uniform vec2 uLean;      // pull toward the pointer, xz per unit height
uniform vec4 uDrop[MAX_DROPS];
uniform int uDropN;
uniform vec3 uBoxMin;    // everything that isn't flat surface lives in this box
uniform vec3 uBoxMax;
uniform vec3 uFlMin;     // the fluid's own bounds
uniform vec3 uFlMax;
uniform vec4 uGlow;      // amount, front x, label glow, room dark
uniform vec4 uCoat;      // centre x, centre z, radius, 1 = covers everything
uniform vec4 uRipple;    // centre x, centre z, seconds since the spikes rose, amplitude
uniform vec4 uWake[MAX_WAKES]; // x, z, age, strength
uniform sampler2D uLabel;
uniform vec4 uLabelRect; // x0, z0, 1 / width, 1 / depth
uniform float uDirect;

out vec4 o;

const float A = ${GEO.A.toFixed(3)};
const float R = ${GEO.R.toFixed(3)};
const float D = ${GEO.D.toFixed(3)};
const vec3 PLANE = vec3(0.70, 0.69, 0.71);  // chalk, linear albedo
const vec3 FLOOR = vec3(0.56, 0.55, 0.575);
const vec3 GLOW = vec3(0.24, 0.08, 1.0);    // blacklight violet
const vec3 HOT = vec3(0.85, 0.52, 1.0);     // the bright edge of the light as it pours in
const vec3 LD = vec3(-0.4396, 0.7993, -0.4096);
const float S = 0.18;                       // spike lattice scale (spacing ≈ 0.82 S)
const float F2 = 0.3660254;
const float G2 = 0.2113249;

${NOISE_GLSL}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
float smax(float a, float b, float k) { return -smin(-a, -b, k); }

// ── Geometry ────────────────────────────────────────────────────────────────
float cap2(vec2 q) { return length(vec2(q.x - clamp(q.x, -A, A), q.y)) - R; }

float ground(vec3 p) {
  float hole = smax(cap2(p.xz), -(p.y + D), 0.3);
  return smax(p.y, -hole, 0.09);
}

float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2) {
  vec3 ba = b - a;
  float l2 = dot(ba, ba);
  float rr = r1 - r2;
  float a2 = l2 - rr * rr;
  float il2 = 1.0 / l2;
  vec3 pa = p - a;
  float y = dot(pa, ba);
  float z = y - l2;
  vec3 xv = pa * l2 - ba * y;
  float x2 = dot(xv, xv);
  float y2 = y * y * l2;
  float z2 = z * z * l2;
  float k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
  if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

// Convex hull of two spheres: a teardrop slug, or one sphere when either contains the other.
float hull(vec3 p, vec3 a, vec3 b, float ra, float rb) {
  float l = length(b - a);
  if (l <= abs(ra - rb) + 1e-3) return ra > rb ? length(p - a) - ra : length(p - b) - rb;
  if (l < 0.01) return min(length(p - a) - ra, length(p - b) - rb); // nearly coincident: the union is the hull
  return sdRoundCone(p, a, b, ra, rb);
}

float lobes(vec3 p) {
  float sy = uBody.y;
  vec3 q = vec3(p.x, (p.y - uBody.x) / sy, p.z);
  float d = hull(q, vec3(uLobeA.x, 0.0, uLobeA.y), vec3(uLobeB.x, 0.0, uLobeB.y), uLobeA.z, uLobeB.z);
  d += uBody.w * sin(q.x * 13.0 - uTime * 9.0) * sin(q.z * 17.0 + q.x * 5.0 + uTime * 6.0);
  return d * min(sy, 1.0);
}

float spike(vec3 p, vec2 id) {
  vec2 h = hash22(id + 11.0);
  vec2 cell = (id - (id.x + id.y) * G2) * S + (h - 0.5) * S * 0.32;
  float r = uLobeA.z;
  float rad = length(cell) / r;
  if (rad > 0.9) return 1e3;
  float grow = clamp(uSpike.y - 0.45 * rad, 0.0, 1.0);
  float H = uSpike.x * grow * pow(1.0 - rad * rad, 0.75) * (0.6 + 0.4 * h.x);
  if (H < 0.006) return 1e3;
  float top = sqrt(max(r * r - dot(cell, cell), 0.0));
  vec3 base = vec3(uLobeA.x + cell.x, uBody.x + uBody.y * top - 0.035, uLobeA.y + cell.y);
  vec2 lean = cell * uSpike.z + uLean + uSpike.w * vec2(sin(uTime * 1.3 + h.y * 6.283), cos(uTime * 1.1 + h.x * 6.283));
  vec3 dir = normalize(vec3(lean.x, 1.0, lean.y));
  return sdRoundCone(p, base, base + dir * H, min(S * 0.52, H * 0.6), 0.005);
}

float spikes(vec3 p) {
  if (uSpike.x < 0.006) return 1e3;
  float r = uLobeA.z;
  float topBase = uBody.x + uBody.y * r;
  if (p.y > topBase + uSpike.x + 0.1) return p.y - topBase - uSpike.x;
  float dy = max(p.y - (uBody.x + uBody.y * r * 0.75), 0.0);
  vec2 q = p.xz - uLobeA.xy;
  float widen = 1.0 + uSpike.z * dy;
  vec2 c = (q - uLean * dy) / widen;
  vec2 x = c / S;
  vec2 i = floor(x + (x.x + x.y) * F2);
  vec2 x0 = x - i + (i.x + i.y) * G2;
  vec2 o1 = x0.x > x0.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  float d = min(spike(p, i), min(spike(p, i + o1), spike(p, i + 1.0)));
  // Among the spikes, never step further than half a lattice cell: a spike one cell over may be next.
  if (p.y > uBody.x + uBody.y * r * 0.43 - 0.04 && length(c) < r + S) d = min(d, 0.42 * S * widen);
  return d;
}

// Outside the fluid's bounds by more than the margin, the distance to the bounds stands in (a lower bound: fine for
// marching, but AO and shadows need the real thing nearby, so they pass a margin wider than their reach).
float fluidM(vec3 p, float margin) {
  vec3 c = 0.5 * (uFlMax + uFlMin);
  vec3 b = abs(p - c) - 0.5 * (uFlMax - uFlMin);
  float bd = length(max(b, 0.0)) + min(max(b.x, max(b.y, b.z)), 0.0);
  if (bd > margin) return bd;
  float d = smin(lobes(p), spikes(p), 0.07);
  for (int i = 0; i < MAX_DROPS; i++) {
    if (i >= uDropN) break;
    d = smin(d, length(p - uDrop[i].xyz) - uDrop[i].w, 0.09);
  }
  return d;
}
float fluid(vec3 p) { return fluidM(p, 0.08); }
float mapL(vec3 p) { return min(ground(p), fluidM(p, 0.36)); }

vec3 nFluid(vec3 p, float e) {
  const vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * fluid(p + k.xyy * e) + k.yyx * fluid(p + k.yyx * e) + k.yxy * fluid(p + k.yxy * e) + k.xxx * fluid(p + k.xxx * e));
}
vec3 nGround(vec3 p, float e) {
  const vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * ground(p + k.xyy * e) + k.yyx * ground(p + k.yyx * e) + k.yxy * ground(p + k.yxy * e) + k.xxx * ground(p + k.xxx * e));
}

float softShadow(vec3 ro) {
  float res = 1.0;
  float t = 0.015;
  float ph = 1e5;
  for (int i = 0; i < 32; i++) {
    float h = mapL(ro + LD * t);
    // Improved penumbra estimate (fewer bands than plain k·h/t).
    float y = h * h / (2.0 * ph);
    float d = sqrt(max(h * h - y * y, 0.0));
    res = min(res, 9.0 * d / max(0.0, t - y));
    ph = h;
    t += clamp(h, 0.012, 0.14);
    if (res < 0.01 || t > 1.4) break;
  }
  res = clamp(res, 0.0, 1.0);
  return res * res * (3.0 - 2.0 * res);
}

float calcAO(vec3 p, vec3 n) {
  float occ = 0.0;
  float w = 1.0;
  for (int i = 1; i <= 3; i++) {
    float h = 0.035 * float(i * i);
    occ += max(h - mapL(p + n * h), 0.0) * w;
    w *= 0.6;
  }
  return clamp(1.0 - 1.5 * occ, 0.0, 1.0);
}

// ── Light ───────────────────────────────────────────────────────────────────
// The studio: a big softbox up and to the left, a broad soft wash behind (what the coat mirrors), and a hard
// strip light behind that only the drop's curves pick out (strip = 0 for the coat, or it reads as a line).
vec3 sky(vec3 d, float strip) {
  float dark = uGlow.w;
  vec3 c = mix(vec3(0.045, 0.045, 0.05), vec3(0.2, 0.2, 0.21), smoothstep(-0.25, 0.85, d.y)) * mix(1.0, 0.06, dark);
  if (d.y > 0.02) {
    vec2 q = d.xz / d.y;
    vec2 b = abs(q - vec2(-0.72, 0.04)) - vec2(0.40, 0.27);
    float sb = length(max(b, 0.0)) + min(max(b.x, b.y), 0.0) - 0.1;
    c += mix(26.0, 2.6, dark) * (1.0 - smoothstep(-0.04, 0.1, sb));
    vec2 b2 = abs(q - vec2(0.95, -0.2)) - vec2(0.14, 0.22);
    float sb2 = length(max(b2, 0.0)) + min(max(b2.x, b2.y), 0.0) - 0.05;
    c += mix(7.0, 1.0, dark) * (1.0 - smoothstep(-0.03, 0.06, sb2));
    float wy = (q.y + 1.2) / 0.38;
    float wash = exp(-wy * wy) * (1.0 - smoothstep(1.0, 2.8, abs(q.x - 0.2)));
    c += mix(vec3(1.2), vec3(0.3, 0.29, 0.36), dark) * wash;
    vec2 s = abs(q - vec2(0.3, -1.3)) - vec2(1.6, 0.045);
    float ss = length(max(s, 0.0)) + min(max(s.x, s.y), 0.0);
    c += strip * mix(3.2, 1.3, dark) * (1.0 - smoothstep(0.0, 0.07, ss));
  }
  return c;
}

float glowMask(float x) { return uGlow.x * (1.0 - smoothstep(uGlow.y - 0.22, uGlow.y + 0.34, x)); }
vec3 glowAt(float x, float floorK) {
  float hx = (x - uGlow.y) / 0.34;
  float hot = exp(-hx * hx);
  return mix(GLOW, HOT, hot * 0.6) * (0.28 + 0.72 * floorK) * 1.7 * glowMask(x);
}

// Where the drop's reflections land: the surface around, the channel floor, or the room above.
vec3 envHit(vec3 p, vec3 r) {
  if (r.y < -0.01) {
    float dark = uGlow.w;
    if (p.y > 0.0) {
      vec3 h = p + r * (-p.y / r.y);
      float c2 = cap2(h.xz);
      if (c2 > 0.0) {
        vec3 s = PLANE * 0.6 * (1.0 - 0.96 * dark);
        return s + glowAt(clamp(h.x, -A, A), 1.0) * (0.12 * exp(-c2 / 0.12) + 0.04 * exp(-c2 / 0.5));
      }
    }
    vec3 h = p + r * ((-D - p.y) / r.y);
    return FLOOR * 0.55 * (1.0 - 0.96 * dark) + glowAt(h.x, 1.0) * 0.42;
  }
  return sky(r, 1.0);
}

vec3 shadeFluid(vec3 p, vec3 n, vec3 rd) {
  vec3 r = reflect(rd, n);
  float F = 0.04 + 0.82 * pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 5.0);
  return vec3(0.004) * (0.5 + 0.5 * max(dot(n, LD), 0.0)) + F * envHit(p, r);
}

// ── The coat ────────────────────────────────────────────────────────────────
float floodField(vec2 xz) {
  vec2 d = xz - uCoat.xy;
  float r = length(d);
  vec2 dir = d / max(r, 1e-4);
  float big = fbm(dir * 1.8 + vec2(3.1, 7.7)) - 0.5;
  float fine = vnoise(dir * 7.0 + vec2(1.3, 2.9)) - 0.5;
  float wig = vnoise(xz * 4.5 + 5.0) - 0.5;
  return uCoat.z * (1.0 + 0.38 * big + 0.16 * fine) + 0.08 * wig - r;
}

// Splash drops thrown ahead of the front; > 0 inside one.
float splash(vec2 xz) {
  vec2 id = floor(xz / 0.3);
  vec2 h = hash22(id + 31.0);
  if (h.x < 0.45) return -1.0;
  vec2 c = (id + 0.25 + 0.5 * hash22(id + 7.0)) * 0.3;
  float e = floodField(c);
  float rr = (0.025 + 0.06 * h.y) * smoothstep(-0.75, -0.08, e) * step(e, 0.0);
  return rr - length(xz - c);
}

vec3 coatNormal(vec2 xz, float e) {
  vec2 g = vec2(0.0);
  if (uCoat.w < 0.5) {
    vec2 d = xz - uCoat.xy;
    g += d / max(length(d), 1e-4) * 1.1 * exp(-max(e, 0.0) / 0.045); // meniscus: the front slopes down
  }
  if (uRipple.w > 0.001) {
    vec2 dr = xz - uRipple.xy;
    float rr = length(dr);
    float s = 0.0;
    for (int i = 0; i < 4; i++) {
      float rad = 2.1 * (uRipple.z - 0.3 * float(i));
      if (rad <= 0.0) break;
      float x = (rr - rad) / 0.17;
      s += 2.0 * x * exp(-x * x) * exp(-0.22 * rad) * (1.0 - 0.2 * float(i));
    }
    g += dr / max(rr, 1e-4) * s * uRipple.w;
  }
  for (int i = 0; i < MAX_WAKES; i++) {
    vec4 w = uWake[i];
    if (w.w <= 0.0) continue;
    vec2 dw = xz - w.xy;
    float rw = length(dw);
    float x = (rw - 0.06 - 1.1 * w.z) / 0.09;
    g += dw / max(rw, 1e-4) * 2.0 * x * exp(-x * x) * w.w * exp(-2.2 * w.z);
  }
  return normalize(vec3(g.x, 1.0, g.y));
}

vec3 coatColor(vec3 n, vec3 rd) {
  vec3 r = reflect(rd, n);
  float F = 0.04 + 0.96 * pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 5.0);
  return vec3(0.004) + F * sky(r, 0.0);
}

// ── The surface (top, lip, walls, floor) ────────────────────────────────────
vec3 surface(vec3 p, vec3 n, vec3 rd, float t, bool inBox) {
  float dark = uGlow.w;
  float inner = 1.0 - smoothstep(-0.07, -0.012, p.y);
  float sh = 1.0;
  float ao = 1.0;
  if (inBox && p.y < -0.01) {
    ao = calcAO(p, n);
    sh = softShadow(p + n * 0.012);
  }
  float key = max(dot(n, LD), 0.0) * sh;
  float amb = (0.55 + 0.45 * n.y + 0.3 * inner * (1.0 - n.y)) * ao;
  vec2 sc = p.xz - vec2(-0.2, -0.4);
  float spot = mix(0.72, 1.0, exp(-dot(sc, sc) / 14.0));
  float room = (1.0 - 0.25 * dark) * mix(spot, 1.0, inner) * (1.0 - 0.95 * dark * inner);
  vec3 col = mix(PLANE, FLOOR, inner) * (0.7 * key + 0.5 * amb) * room;

  // printed label (explicit gradients: this runs in divergent branches)
  float wpp = uPix * t;
  vec2 luv = vec2((p.x - uLabelRect.x) * uLabelRect.z, (p.z - uLabelRect.y) * uLabelRect.w);
  float inL = step(0.0, luv.x) * step(luv.x, 1.0) * step(0.0, luv.y) * step(luv.y, 1.0) * (1.0 - inner);
  vec3 L = textureGrad(uLabel, luv, vec2(wpp * uLabelRect.z, 0.0), vec2(0.0, wpp / max(-rd.y, 0.12) * uLabelRect.w)).rgb * inL;
  col *= 1.0 - 0.34 * L.r - 0.5 * (L.g + L.b);

  if (uCoat.z > 0.0 && inner < 0.999) {
    float cov = 1.0;
    float e = 10.0;
    if (uCoat.w < 0.5) {
      e = floodField(p.xz);
      if (e > -0.8 && e < 0.05) e = max(e, splash(p.xz));
      cov = clamp(e / max(wpp / max(-rd.y, 0.15), 0.002) + 0.5, 0.0, 1.0);
    }
    cov *= 1.0 - inner;
    if (cov > 0.0) col = mix(col, coatColor(coatNormal(p.xz, e), rd), cov);
  }

  // the blacklight: inside the channel, catching the lip, spilling onto the surface around
  float zc = p.z / R;
  col += glowAt(p.x, 1.0 - smoothstep(-D + 0.02, -D + 0.2, p.y)) * inner * (1.0 - 0.3 * zc * zc);
  float c2 = max(cap2(p.xz), 0.0);
  vec3 g = glowAt(clamp(p.x, -A, A), 1.0);
  col += g * (1.0 - inner) * (0.5 * smoothstep(0.02, 0.25, 1.0 - n.y) + 0.1 * exp(-c2 / 0.1) + 0.045 * exp(-c2 / 0.55));
  col += mix(GLOW, HOT, 0.3) * 2.1 * (L.r + L.b) * uGlow.z;
  return col;
}

vec2 boxHit(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBoxMin - ro) * inv;
  vec3 t1 = (uBoxMax - ro) * inv;
  vec3 mn = min(t0, t1);
  vec3 mx = max(t0, t1);
  return vec2(max(max(mn.x, mn.y), mn.z), min(min(mx.x, mx.y), mx.z));
}

vec3 tone(vec3 c) {
  vec3 k = 0.8 + 0.2 * (1.0 - exp(-(c - 0.8) / 0.2));
  return mix(c, k, step(0.8, c));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * uRes.y);
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamF * uFocal + uCamR * uv.x + uCamU * uv.y);
  vec3 col;

  bool hit = false;
  bool wet = false;
  float t = 0.0;
  float nearF = 1e3;
  vec2 tb = boxHit(ro, rd);
  float tPlane = rd.y < -1e-4 ? -ro.y / rd.y : 1e5;
  // A ray that meets the surface before it reaches the box would enter the box inside the ground: it's a plain
  // surface hit, never a march.
  if (tb.x < tb.y && tb.y > 0.0 && tb.x < tPlane) {
    t = max(tb.x, 0.0);
    for (int i = 0; i < 160; i++) {
      vec3 p = ro + rd * t;
      float g = ground(p);
      float f = fluid(p);
      float e = uPix * t;
      nearF = min(nearF, f / e);
      if (min(g, f) < e * 0.4) {
        hit = true;
        wet = f < g;
        break;
      }
      t += min(g, f) * 0.85;
      if (t > tb.y) break;
    }
  }

  if (hit && wet) {
    vec3 p = ro + rd * t;
    col = shadeFluid(p, nFluid(p, max(0.0012, uPix * t * 0.5)), rd);
  } else if (rd.y < -1e-4) {
    if (!hit) t = tPlane;
    vec3 p = ro + rd * t;
    vec3 n = hit ? nGround(p, max(0.0015, uPix * t * 0.5)) : vec3(0.0, 1.0, 0.0);
    col = surface(p, n, rd, t, hit);
    col = mix(col, col * 0.22, clamp(1.0 - nearF, 0.0, 1.0) * 0.85); // a fluid edge skimmed this pixel
  } else {
    col = sky(rd, 1.0);
  }

  if (uDirect > 0.5) {
    col = pow(tone(col), vec3(1.0 / 2.2)) + (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  }
  o = vec4(col, 1.0);
}
`;

/** 4× (or 2×) box downsample with a soft threshold on the first pass. */
export const DOWN_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform vec2 uDst;
uniform float uThresh;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uDst;
  vec3 c = texture(uSrc, uv + uSrcTexel * vec2(-1.0, -1.0)).rgb + texture(uSrc, uv + uSrcTexel * vec2(1.0, -1.0)).rgb
         + texture(uSrc, uv + uSrcTexel * vec2(-1.0, 1.0)).rgb + texture(uSrc, uv + uSrcTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  if (uThresh > 0.0) c *= smoothstep(uThresh * 0.55, uThresh * 1.5, max(c.r, max(c.g, c.b)));
  o = vec4(c, 1.0);
}
`;

/** 9-tap Gaussian along uDir (one texel), five bilinear fetches. */
export const BLUR_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uDir;
uniform vec2 uDst;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uDst;
  vec3 c = texture(uSrc, uv).rgb * 0.2270270270;
  c += (texture(uSrc, uv + uDir * 1.3846153846).rgb + texture(uSrc, uv - uDir * 1.3846153846).rgb) * 0.3162162162;
  c += (texture(uSrc, uv + uDir * 3.2307692308).rgb + texture(uSrc, uv - uDir * 3.2307692308).rgb) * 0.0702702703;
  o = vec4(c, 1.0);
}
`;

/** Scene + three bloom levels, soft-knee tone curve, sRGB, dither. */
export const COMPOSITE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uB1;
uniform sampler2D uB2;
uniform sampler2D uB3;
uniform vec2 uRes;
uniform vec3 uBloomK;
out vec4 o;
${NOISE_GLSL}
vec3 tone(vec3 c) {
  vec3 k = 0.8 + 0.2 * (1.0 - exp(-(c - 0.8) / 0.2));
  return mix(c, k, step(0.8, c));
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c = texture(uScene, uv).rgb + uBloomK.x * texture(uB1, uv).rgb + uBloomK.y * texture(uB2, uv).rgb + uBloomK.z * texture(uB3, uv).rgb;
  c = pow(tone(c), vec3(1.0 / 2.2));
  o = vec4(c + (hash(gl_FragCoord.xy) - 0.5) / 255.0, 1.0);
}
`;
