import { describe, expect, it } from "vitest";
import { computeChronology } from "../src/db/chronology.js";
import { fixtureMaster } from "./helpers/fixture-db.js";

const products = fixtureMaster().products;
const chrono = computeChronology(products);
const byCode = (code: string) => {
  const p = products.find((x) => x.label.split(/\s+/)[0] === code || x.value === code);
  if (!p) throw new Error(`no product ${code}`);
  return chrono.get(p.value)!;
};

describe("release chronology", () => {
  it("ranks every product uniquely", () => {
    const ranks = [...chrono.values()].map((c) => c.rank);
    expect(new Set(ranks).size).toBe(products.length);
    expect(Math.min(...ranks)).toBe(1);
  });
  it("DM-01 is the oldest main set and DMyy codes are exact years", () => {
    expect(byCode("DM-01").year).toBeCloseTo(2002.4, 1);
    expect(byCode("DM24-RP1")).toMatchObject({ year: 2024.5, estimated: false });
    expect(byCode("DM24-RP1").rank).toBeGreaterThan(byCode("DMRP-22").rank);
  });
  it("places category blocks back into the timeline", () => {
    // promo N期 ≈ 2001+N: 25期 must be newer than DM-01 and than DMRP-01
    expect(byCode("promoy25").rank).toBeGreaterThan(byCode("DMRP-01").rank);
    expect(byCode("promoy1").rank).toBeLessThan(byCode("DM-10").rank);
    // old decks interpolate between their backbone siblings
    expect(byCode("DMC-41").year).toBeGreaterThan(byCode("DMC-34").year);
    expect(byCode("DMC-41").year).toBeLessThan(byCode("DMC-68").year);
    // DMD decks are 2011-2016, DMBD-01 is just before DMBD-05
    expect(byCode("DMD-01").year).toBeGreaterThan(2011);
    expect(byCode("DMD-35").year).toBeLessThan(2017);
    expect(byCode("DMBD-01").rank).toBeLessThan(byCode("DMBD-05").rank);
    expect(byCode("DMBD-01").year).toBeGreaterThan(2016.5);
  });
  it("is monotonic along the main line", () => {
    const main = ["DM-01", "DM-20", "DM-39", "DMR-01", "DMR-23", "DMRP-01", "DMRP-22", "DM22-RP1", "DM26-RP3"].map((c) => byCode(c).rank);
    expect([...main].sort((a, b) => a - b)).toEqual(main);
  });
});
