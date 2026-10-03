function invalid() {
  return Object.assign(new TypeError('The factory growth policy is invalid.'), { code: 'GROWTH_POLICY_INVALID' });
}
function check(value) { if (!value) throw invalid(); }
function closed(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;

/** Closed durable policies; absent ceilings never mean unlimited growth. */
export function validateGrowthPolicy(value) {
  const versioned = value && Object.hasOwn(value, 'schemaVersion');
  closed(value, versioned ? ['schemaVersion', 'mission', 'budgetCents', 'growthMode', 'maxCells', 'maxDepth']
    : ['mission', 'budgetCents', 'maxCells', 'maxDepth']);
  check(typeof value.mission === 'string' && value.mission.trim().length > 0 && integer(value.budgetCents));
  if (versioned) {
    check(value.schemaVersion === 2 && value.growthMode === 'budget-only' && value.maxCells === null && value.maxDepth === null);
  } else check(integer(value.maxCells, 1) && integer(value.maxDepth));
  return structuredClone(value);
}
