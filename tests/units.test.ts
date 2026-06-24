import { test, expect } from "bun:test";
import { unitInfo, displayBaseQty } from "../src/units";

test("unitInfo maps convertible RU/EN units to a dimension + base factor", () => {
  expect(unitInfo("кг")).toEqual({ dim: "mass", per: 1000 });
  expect(unitInfo("Г")).toEqual({ dim: "mass", per: 1 });
  expect(unitInfo("л")).toEqual({ dim: "vol", per: 1000 });
  expect(unitInfo("ml")).toEqual({ dim: "vol", per: 1 });
});

test("unitInfo returns null for count/opaque units", () => {
  expect(unitInfo("шт")).toBeNull();
  expect(unitInfo("уп")).toBeNull();
  expect(unitInfo(null)).toBeNull();
});

test("displayBaseQty presents grams/ml in the friendliest unit", () => {
  expect(displayBaseQty(800, "mass")).toEqual({ qty: 800, unit: "г" });
  expect(displayBaseQty(1500, "mass")).toEqual({ qty: 1.5, unit: "кг" });
  expect(displayBaseQty(400, "vol")).toEqual({ qty: 400, unit: "мл" });
  expect(displayBaseQty(1200, "vol")).toEqual({ qty: 1.2, unit: "л" });
});
