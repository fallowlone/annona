import { roundQty } from "./scale";

export type Dim = "mass" | "vol";

// Convertible units → dimension + how many base units (g / ml) each is worth.
// Count/opaque units (шт, уп, …) are intentionally absent: they can't be summed
// across different units, so they stay on their own line.
const FACTOR: Record<string, { dim: Dim; per: number }> = {
  г: { dim: "mass", per: 1 },
  гр: { dim: "mass", per: 1 },
  g: { dim: "mass", per: 1 },
  кг: { dim: "mass", per: 1000 },
  kg: { dim: "mass", per: 1000 },
  мл: { dim: "vol", per: 1 },
  ml: { dim: "vol", per: 1 },
  л: { dim: "vol", per: 1000 },
  l: { dim: "vol", per: 1000 },
};

/** A convertible unit's dimension + per-unit base factor (g or ml), else null. */
export function unitInfo(unit: string | null): { dim: Dim; per: number } | null {
  if (!unit) return null;
  return FACTOR[unit.trim().toLowerCase()] ?? null;
}

/** Render a base-unit quantity (grams or millilitres) in the friendliest unit. */
export function displayBaseQty(baseQty: number, dim: Dim): { qty: number; unit: string } {
  if (dim === "mass") {
    return baseQty >= 1000 ? { qty: roundQty(baseQty / 1000), unit: "кг" } : { qty: roundQty(baseQty), unit: "г" };
  }
  return baseQty >= 1000 ? { qty: roundQty(baseQty / 1000), unit: "л" } : { qty: roundQty(baseQty), unit: "мл" };
}
