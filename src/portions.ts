/**
 * How many days a cooked dish covers for a household, assuming one portion per
 * person per day. Clamped to at least 1 day.
 */
export function coverageDays(servings: number, householdSize: number): number {
  if (householdSize <= 0) return servings;
  return Math.max(1, Math.floor(servings / householdSize));
}
