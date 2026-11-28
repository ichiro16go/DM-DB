/** Seeded PRNG (mulberry32). The engine never uses Math.random, so a game is reproducible from its seed. */
export class Rng {
  constructor(private s: number) {
    this.s = s >>> 0;
  }
  get state() {
    return this.s;
  }
  /** float in [0, 1) */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new Error("pick from empty list");
    return xs[this.int(xs.length)]!;
  }
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    return xs;
  }
  /** independent stream for another consumer (e.g. an agent) */
  fork(salt: number): Rng {
    return new Rng((Math.imul(this.s ^ salt, 0x9e3779b1) + salt) >>> 0);
  }
}

/** Text seed → number (so "--seed=abc" works too). */
export function seedOf(v: string | number): number {
  if (typeof v === "number") return v >>> 0;
  if (/^\d+$/.test(v)) return Number(v) >>> 0;
  let h = 2166136261;
  for (const ch of v) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return h >>> 0;
}
