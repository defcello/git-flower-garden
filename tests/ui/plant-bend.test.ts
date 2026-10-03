import { describe, expect, it } from "vitest";
import type { Scene } from "../../src/ui/botanical.ts";
import type { PlantDescription } from "../../src/ui/scene/description.ts";
import { poseFrame, tuftPose } from "../../src/ui/scene/grass.ts";
import {
  bendAt,
  bendSprites,
  plantBend,
  STEM_GIVE,
} from "../../src/ui/scene/plant-bend.ts";

const plant = (over: Partial<PlantDescription> = {}): PlantDescription => ({
  id: "repo/main",
  scene: { grounds: [{ x: 50, y: 200, width: 40 }] } as unknown as Scene,
  x: 900,
  y: 800,
  anchorX: 50,
  anchorY: 200,
  scale: 1.5,
  bounds: { x: 0, y: 0, width: 100, height: 200 },
  wilting: false,
  highlighted: false,
  ...over,
});
const wind = { speed: 8, windX: 8, travel: 0 };

describe("plant bend", () => {
  it("stands exactly as the graph puts it at rest, highlighted, or wilting", () => {
    const frame = poseFrame(wind);
    expect(plantBend(plant(), null, frame)).toBeNull();
    expect(plantBend(plant({ highlighted: true }), 2, frame)).toBeNull();
    expect(plantBend(plant({ wilting: true }), 2, frame)).toBeNull();
    const sprites = [{ x: 50, y: 20, rotate: 0 }];
    expect(bendSprites(sprites, plant(), null)).toBe(sprites);
  });

  it("bends half as far as a tuft of grass in the same wind", () => {
    const frame = poseFrame(wind);
    for (let t = 0; t < 20; t += 1.3) {
      const pose = plantBend(plant(), t, frame);
      if (!pose) throw new Error("no bend");
      expect(pose.height).toBeCloseTo(300, 9);
      const grass = tuftPose(
        {
          x: 900,
          y: 800,
          size: 300,
          kind: 0,
          flip: false,
          seed: 0,
          stretch: 1,
          stiff: 1,
          delay: 0,
        },
        t,
        wind,
        frame,
      ).bend;
      // Same shared field; the plant answers a little later than the tuft.
      expect(Math.abs(pose.bend)).toBeLessThanOrEqual(
        STEM_GIVE * Math.max(Math.abs(grass), 1.45) + 1e-9,
      );
    }
  });

  it("moves the top most and the base not at all, downwind", () => {
    const pose = {
      bend: 0.4,
      heading: { x: 1, z: 0 },
      baseY: 800,
      height: 300,
    };
    expect(bendAt(pose, 0)).toEqual({ dx: 0, dy: 0, turn: 0 });
    expect(bendAt(pose, 150).dx).toBeGreaterThan(0);
    expect(bendAt(pose, 300).dx).toBeGreaterThan(bendAt(pose, 150).dx);
    expect(bendAt({ ...pose, heading: { x: -1, z: 0 } }, 300).dx).toBeLessThan(
      0,
    );
    const [top] = bendSprites([{ x: 50, y: 0, rotate: 0 }], plant(), pose);
    const tip = bendAt(pose, 300);
    expect(top?.x).toBeCloseTo(50 + tip.dx / 1.5, 9);
    expect(top?.y).toBeCloseTo(tip.dy / 1.5, 9);
    expect(top?.rotate).toBeCloseTo(0.4, 9);
  });

  it("keeps every stem's length, beside the middle too", () => {
    // Rows move as one, so a stem anywhere in the row follows the same
    // arc: an upright stem keeps its length, and so does one across.
    const pose = { bend: 0.72, heading: { x: 1, z: 0 }, baseY: 0, height: 300 };
    let length = 0;
    let last = { x: 0, y: 0 };
    for (let v = 3; v <= 300; v += 3) {
      const { dx, dy } = bendAt(pose, v);
      const next = { x: dx, y: -v + dy };
      length += Math.hypot(next.x - last.x, next.y - last.y);
      last = next;
    }
    expect(length).toBeCloseTo(300, 1);
    expect(bendAt(pose, 300).dy).toBeGreaterThan(0);
  });

  it("sways sideways in a wind straight into the scene, as gusts buffet it", () => {
    const frame = poseFrame({ speed: 8, windX: 0, windZ: 8, travel: 0 });
    let widest = 0;
    for (let t = 0; t < 20; t += 0.5) {
      const pose = plantBend(plant(), t, frame);
      if (!pose) throw new Error("no bend");
      widest = Math.max(widest, Math.abs(bendAt(pose, pose.height).dx));
    }
    expect(widest).toBeGreaterThan(1);
  });

  it("bends in a wind into the scene or toward the viewer", () => {
    const frame = poseFrame({ speed: 8, windX: 0, windZ: 8, travel: 0 });
    const pose = plantBend(plant(), 3, frame);
    if (!pose) throw new Error("no bend");
    expect(pose.bend).not.toBe(0);
    const north = { ...pose, bend: 0.5, heading: { x: 0, z: 1 } };
    const tip = bendAt(north, pose.height);
    expect(tip.dx).toBeCloseTo(0, 9);
    expect(tip.turn).toBeCloseTo(0, 9);
    // Into the scene as toward the viewer, the top sinks visibly.
    const south = { ...north, heading: { x: 0, z: -1 } };
    expect(tip.dy).toBeGreaterThan(0.05 * pose.height);
    expect(bendAt(south, pose.height).dy).toBeCloseTo(tip.dy, 9);
  });
});
