import { describe, expect, it } from 'vitest';
import { easedPath } from './pointer';

describe('easedPath', () => {
  it('ends exactly at the target and never at the start', () => {
    const path = easedPath({ x: 10, y: 20 }, { x: 410, y: 320 });
    expect(path[path.length - 1]).toEqual({ x: 410, y: 320 });
    expect(path[0]).not.toEqual({ x: 10, y: 20 });
  });

  it('uses 8 to 20 steps depending on distance', () => {
    expect(easedPath({ x: 0, y: 0 }, { x: 5, y: 0 })).toHaveLength(8);
    expect(easedPath({ x: 0, y: 0 }, { x: 5000, y: 0 })).toHaveLength(20);
  });

  it('moves steadily toward the target, slow-fast-slow', () => {
    const xs = easedPath({ x: 0, y: 0 }, { x: 1000, y: 0 }).map((p) => p.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    const steps = xs.map((x, i) => x - (xs[i - 1] ?? 0));
    expect(steps[Math.floor(steps.length / 2)]).toBeGreaterThan(steps[0]);
    expect(steps[Math.floor(steps.length / 2)]).toBeGreaterThan(steps[steps.length - 1]);
  });
});
