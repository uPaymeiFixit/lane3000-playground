import { describe, expect, it } from "bun:test";

import { framePng } from "../src/gfx/encode.js";
import { MAP, Raid, VIEW_H, W } from "../src/programs/raid.js";
import { PyRandom } from "../src/util/py-random.js";

function game(): Raid {
  return new Raid(new PyRandom(1));
}

describe("SKIMMER RAID", () => {
  it("loads the map: start position, skimmers and pickups", () => {
    const g = game();
    expect([g.px, g.py]).toEqual([1.5, 1.5]);
    const count = (ch: string): number => MAP.join("").split(ch).length - 1;
    expect(g.total).toBe(count("S"));
    expect(g.items.length).toBe(count("+") + count("a"));
  });

  it("raycasts to the nearest wall", () => {
    const g = game();
    expect(g.cast(Math.PI).dist).toBeCloseTo(0.5, 6); // west wall from x = 1.5
    expect(g.cast(-Math.PI / 2).dist).toBeCloseTo(0.5, 6); // north wall from y = 1.5
  });

  it("walls block movement", () => {
    const g = game();
    g.angle = Math.PI; // face the west wall
    g.press("U");
    g.press("U");
    expect(g.px).toBeGreaterThan(1.2);
  });

  it("two hits destroy a skimmer in the line of fire", () => {
    const g = game();
    const e = g.enemies[0];
    if (e === undefined) throw new Error("map has no skimmers");
    g.px = e.x - 2.5;
    g.py = e.y;
    g.angle = 0;
    g.press("\r");
    expect(g.msg).toBe("Hit!");
    g.press("\r");
    expect(g.kills).toBe(1);
    expect(g.enemies).not.toContain(e);
    expect(g.ammo).toBe(22);
  });

  it("an adjacent skimmer attacks, then cools down", () => {
    const g = game();
    const e = g.enemies[0];
    if (e === undefined) throw new Error("map has no skimmers");
    g.px = e.x - 0.6;
    g.py = e.y;
    g.tick();
    const afterFirst = g.hp;
    expect(afterFirst).toBeLessThan(100);
    g.tick();
    expect(g.hp).toBe(afterFirst); // cooldown
  });

  it("frames are 320x240 and small palette PNGs", async () => {
    const g = game();
    const img = g.render();
    expect([img.width, img.height]).toEqual([W, 240]);
    expect(VIEW_H).toBe(200);
    const png = await framePng(img);
    expect(png.length).toBeLessThan(8000);
  });
});
