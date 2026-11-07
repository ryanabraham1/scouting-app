import { describe, expect, it } from 'vitest';
import { FIELD, homography, LANDMARKS, project, type Point } from '../autoScoutGeometry';

// The real 2026mttd calibration, checked by eye against the broadcast.
const PIXELS: Record<string, Point> = {
  blue_hub_center: [610, 766],
  red_hub_center: [1256, 777],
  center_line_yW: [935, 711],
  center_line_y0: [931, 859],
};

describe('field projection', () => {
  const names = Object.keys(LANDMARKS);
  const h = homography(names.map((n) => LANDMARKS[n]), names.map((n) => PIXELS[n]));

  it('lands exactly on the placed landmarks', () => {
    for (const name of names) {
      const [x, y] = project(h as number[], LANDMARKS[name]);
      expect(x).toBeCloseTo(PIXELS[name][0], 3);
      expect(y).toBeCloseTo(PIXELS[name][1], 3);
    }
  });

  it('agrees with the Python calibration on the field corners', () => {
    const corner = (p: Point) => project(h as number[], p).map(Math.round);
    expect(corner([0, 0])).toEqual([32, 844]);
    expect(corner([FIELD.length, FIELD.width])).toEqual([1553, 722]);
  });

  it('needs four points that define a plane', () => {
    expect(homography([[0, 0], [1, 1], [2, 2]], [[0, 0], [1, 1], [2, 2]])).toBeNull();
    expect(homography([[0, 0], [1, 0], [2, 0], [3, 0]], [[0, 0], [1, 0], [2, 0], [3, 0]])).toBeNull();
  });
});
