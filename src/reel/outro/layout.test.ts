import { describe, expect, test } from "bun:test";
import { COLUMN, layoutHandle, lineWidth, MAX_SIZE } from "./layout";

describe("layoutHandle", () => {
  test("the default handle breaks after the underscore and stays big", () => {
    const l = layoutHandle("@Waterhouse_Studios");
    expect(l.lines).toEqual(["@WATERHOUSE_", "STUDIOS"]);
    expect(l.size).toBeGreaterThanOrEqual(80);
    for (const line of l.lines) expect(lineWidth(line, l.size)).toBeLessThanOrEqual(COLUMN);
  });

  test("a short handle is one line at the title size", () => {
    expect(layoutHandle("@denzo")).toEqual({ lines: ["@DENZO"], size: MAX_SIZE });
  });

  test("a long handle without a separator shrinks on one line, never below 40", () => {
    const l = layoutHandle("@waterhousestudiosamsterdam");
    expect(l.lines).toHaveLength(1);
    expect(l.size).toBeGreaterThanOrEqual(40);
  });

  test("a medium handle fits one line when it can", () => {
    const l = layoutHandle("@water_house");
    expect(l.lines).toEqual(["@WATER_HOUSE"]);
    expect(lineWidth(l.lines[0], l.size)).toBeLessThanOrEqual(COLUMN);
  });
});
