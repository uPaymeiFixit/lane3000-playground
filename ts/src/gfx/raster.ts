/**
 * A small RGB image with Pillow-style drawing (ImageDraw semantics: boxes are inclusive
 * [x0, y0, x1, y1], shapes are not anti-aliased, text is). The ellipse and wide-line rasterizers
 * follow Pillow's Draw.c so frames match the Python output pixel for pixel. Frames are drawn here
 * and then encoded by encode.ts.
 */

import { drawText, type Anchor, type Font } from "./text.js";

export type Rgb = readonly [r: number, g: number, b: number];
/** Inclusive pixel box, as in Pillow: [x0, y0, x1, y1]. */
export type Box = readonly [x0: number, y0: number, x1: number, y1: number];
export type Point = readonly [x: number, y: number];

export const WHITE: Rgb = [255, 255, 255];
export const BLACK: Rgb = [0, 0, 0];

/** Pillow's ROUND_UP / ROUND_DOWN (round half away from / towards zero). */
function roundUp(f: number): number {
  return f >= 0 ? Math.floor(f + 0.5) : -Math.floor(Math.abs(f) + 0.5);
}
function roundDown(f: number): number {
  return f >= 0 ? Math.ceil(f - 0.5) : -Math.ceil(Math.abs(f) - 0.5);
}

export class Raster {
  /** RGB, 3 bytes per pixel, row-major. */
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    background: Rgb = BLACK,
  ) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError(`bad raster size ${width}x${height}`);
    }
    this.data = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) this.data.set(background, i * 3);
  }

  get(x: number, y: number): Rgb {
    const i = (y * this.width + x) * 3;
    return [this.data[i] ?? 0, this.data[i + 1] ?? 0, this.data[i + 2] ?? 0];
  }

  /** Set one pixel; coordinates outside the image are ignored. */
  set(x: number, y: number, c: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.data.set(c, (y * this.width + x) * 3);
  }

  /** Blend `c` over a pixel with coverage `alpha` (0-255), like Pillow pasting through a mask. */
  blend(x: number, y: number, c: Rgb, alpha: number): void {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    if (alpha >= 255) {
      this.set(x, y, c);
      return;
    }
    const i = (y * this.width + x) * 3;
    for (let k = 0; k < 3; k++) {
      const d = this.data[i + k] ?? 0;
      const s = c[k] ?? 0;
      // Pillow's BLEND macro: tmp = (s - d) * a + 128; d + (((tmp >> 8) + tmp) >> 8)
      const tmp = (s - d) * alpha + 128;
      this.data[i + k] = d + (((tmp >> 8) + tmp) >> 8);
    }
  }

  /** Horizontal run x0..x1 inclusive (nothing when x0 > x1), clipped to the image. */
  hline(x0: number, y: number, x1: number, c: Rgb): void {
    if (y < 0 || y >= this.height) return;
    const a = Math.max(0, x0);
    const b = Math.min(this.width - 1, x1);
    for (let x = a; x <= b; x++) this.data.set(c, (y * this.width + x) * 3);
  }

  rectangle(box: Box, style: { readonly fill?: Rgb; readonly outline?: Rgb }): void {
    const [x0, y0, x1, y1] = box;
    if (style.fill !== undefined) {
      for (let y = y0; y <= y1; y++) this.hline(x0, y, x1, style.fill);
    }
    if (style.outline !== undefined) {
      const c = style.outline;
      this.hline(x0, y0, x1, c);
      this.hline(x0, y1, x1, c);
      for (let y = y0; y <= y1; y++) {
        this.set(x0, y, c);
        this.set(x1, y, c);
      }
    }
  }

  /** Filled ellipse inscribed in the inclusive box (Pillow's ellipseNew). */
  ellipse(box: Box, fill: Rgb): void {
    const [x0, y0, x1, y1] = box;
    for (const [y, a, b] of ellipseSpans(x1 - x0, y1 - y0)) this.hline(x0 + a, y0 + y, x0 + b, fill);
  }

  /** Filled rectangle with rounded corners (Pillow rounded_rectangle with a fill). */
  roundedRectangle(box: Box, radius: number, fill: Rgb): void {
    const [x0, y0, x1, y1] = box;
    const d = radius * 2;
    const fullX = d >= x1 - x0 - 1;
    const fullY = d >= y1 - y0 - 1;
    if (fullX && fullY) {
      this.ellipse(box, fill);
      return;
    }
    if (fullX || fullY || radius <= 0) {
      // Not used by the games: fall back to a plain rectangle.
      this.rectangle(box, { fill });
      return;
    }
    const r = Math.floor(d / 2);
    // Corners: quarters of the (d+1)x(d+1) circle; the centre row/column belongs to the corner.
    for (const [y, a, b] of ellipseSpans(d, d)) {
      if (y > r) continue;
      this.hline(x0 + a, y0 + y, x0 + r, fill); // top left
      this.hline(x1 - d + r, y0 + y, x1 - d + b, fill); // top right
      this.hline(x0 + a, y1 - d + (d - y), x0 + r, fill); // bottom left
      this.hline(x1 - d + r, y1 - d + (d - y), x1 - d + b, fill); // bottom right
    }
    this.rectangle([x0 + r + 1, y0, x1 - r - 1, y1], { fill });
    this.rectangle([x0, y0 + r + 1, x0 + r, y1 - r - 1], { fill });
    this.rectangle([x1 - r, y0 + r + 1, x1, y1 - r - 1], { fill });
  }

  /** Line through two points: width 1 is Bresenham, wider lines follow Pillow's wide line. */
  line(from: Point, to: Point, fill: Rgb, width = 1): void {
    const [ax, ay] = from;
    const [bx, by] = to;
    if (width <= 1) {
      let x = ax;
      let y = ay;
      const dx = Math.abs(bx - ax);
      const dy = -Math.abs(by - ay);
      const sx = ax < bx ? 1 : -1;
      const sy = ay < by ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        this.set(x, y, fill);
        if (x === bx && y === by) break;
        const e2 = 2 * err;
        if (e2 >= dy) {
          err += dy;
          x += sx;
        }
        if (e2 <= dx) {
          err += dx;
          y += sy;
        }
      }
      return;
    }
    const dx = bx - ax;
    const dy = by - ay;
    if (dx === 0 && dy === 0) {
      this.set(ax, ay, fill);
      return;
    }
    const big = Math.hypot(dx, dy);
    const small = (width - 1) / 2;
    const ratioMax = roundUp(small) / big;
    const ratioMin = roundDown(small) / big;
    const dxmin = roundDown(ratioMin * dy);
    const dxmax = roundDown(ratioMax * dy);
    const dymin = roundDown(ratioMin * dx);
    const dymax = roundDown(ratioMax * dx);
    this.convexPolygon(
      [
        [ax - dxmin, ay + dymax],
        [bx - dxmin, by + dymax],
        [bx + dxmax, by - dymin],
        [ax + dxmax, ay - dymin],
      ],
      fill,
    );
  }

  /** Filled convex polygon with integer vertices, scan-converted like Pillow's polygon fill. */
  convexPolygon(points: readonly Point[], fill: Rgb): void {
    const ys = points.map((p) => p[1]);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    for (let y = top; y <= bottom; y++) {
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const q = points[(i + 1) % points.length];
        if (p === undefined || q === undefined) continue;
        const [px, py] = p;
        const [qx, qy] = q;
        if (y < Math.min(py, qy) || y > Math.max(py, qy)) continue;
        const xs = py === qy ? [px, qx] : [px + ((y - py) * (qx - px)) / (qy - py)];
        for (const x of xs) {
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
      }
      if (lo <= hi) this.hline(roundUp(lo), y, roundDown(hi), fill);
    }
  }

  text(at: Point, text: string, font: Font, fill: Rgb, anchor: Anchor = "la"): void {
    drawText(this, at, text, font, fill, anchor);
  }
}

// ---- Pillow's ellipse rasterizer (Draw.c: quarter_state / ellipse_state / ellipseNew) ----------

class Quarter {
  private cx: number;
  private cy: number;
  private readonly ex: number;
  private readonly ey: number;
  private readonly a2: number;
  private readonly b2: number;
  private readonly a2b2: number;
  finished: boolean;

  constructor(a: number, b: number) {
    this.finished = a < 0 || b < 0;
    this.cx = a;
    this.cy = b % 2;
    this.ex = a % 2;
    this.ey = b;
    this.a2 = a * a;
    this.b2 = b * b;
    this.a2b2 = this.a2 * this.b2;
  }

  private delta(x: number, y: number): number {
    return Math.abs(this.a2 * y * y + this.b2 * x * x - this.a2b2);
  }

  /** Next point of the quarter (in doubled coordinates), or null when done. */
  next(): Point | null {
    if (this.finished) return null;
    const ret: Point = [this.cx, this.cy];
    if (this.cx === this.ex && this.cy === this.ey) {
      this.finished = true;
    } else {
      let nx = this.cx;
      let ny = this.cy + 2;
      let ndelta = this.delta(nx, ny);
      if (nx > 1) {
        let newdelta = this.delta(this.cx - 2, this.cy + 2);
        if (ndelta > newdelta) {
          nx = this.cx - 2;
          ny = this.cy + 2;
          ndelta = newdelta;
        }
        newdelta = this.delta(this.cx - 2, this.cy);
        if (ndelta > newdelta) {
          nx = this.cx - 2;
          ny = this.cy;
        }
      }
      this.cx = nx;
      this.cy = ny;
    }
    return ret;
  }
}

/**
 * Rows of a filled ellipse whose inclusive box is (a+1) x (b+1) pixels: [row, firstX, lastX],
 * relative to the box's top-left corner.
 */
export function ellipseSpans(a: number, b: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  if (a < 0 || b < 0) return out;
  const outer = new Quarter(a, b);
  const first = outer.next();
  if (first === null) return out;
  let [pr, py] = first;
  const leftmost = a % 2;
  let pl = leftmost;
  // A filled ellipse is an outline as wide as a + b: the inner quarter never starts.
  const inner = new Quarter(a - 2 * (a + b - 1), b - 2 * (a + b - 1));
  let finished = false;
  const emit = (x0: number, y: number, x1: number): void => {
    out.push([Math.trunc((y + b) / 2), Math.trunc((x0 + a) / 2), Math.trunc((x1 + a) / 2)]);
  };
  while (!finished) {
    const y = py;
    let l = pl;
    const r = pr;
    let p = outer.next();
    while (p !== null && p[1] <= y) p = outer.next();
    if (p === null) finished = true;
    else [pr, py] = p;
    let q = inner.next();
    while (q !== null && q[1] <= y) {
      l = q[0];
      q = inner.next();
    }
    pl = q === null ? leftmost : q[0];
    if ((l > 0 || l < r) && y > 0) emit(l === 0 ? 2 : l, y, r);
    if (y > 0) emit(-r, y, -l);
    if (l > 0 || l < r) emit(l === 0 ? 2 : l, -y, r);
    emit(-r, -y, -l);
  }
  return out;
}
