// Compares the pipeline's answer with the expected answer of a test case.
//
// compare modes (set "compare" in the test case; default "auto"):
//   "auto"      numbers with a small tolerance, lists in any order, everything else exact
//   "exact"     same values, lists in the same order
//   "unordered" same values, lists in any order
//   "number"    one number, 0.1% tolerance (volumes, areas, lengths)
//   "contains"  every expected value appears somewhere in the answer
//               (use it when the answer's shape may vary, e.g. a dict with extra keys)
// In every mode, a list with exactly one item counts as that item when one value is expected.

const show = (v) => JSON.stringify(v);

function isNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function numbersEqual(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

function deepEqual(actual, expected, unordered, tolerance) {
  if (isNumber(actual) && isNumber(expected)) return numbersEqual(actual, expected, tolerance);
  if (actual === null || expected === null) return actual === expected;

  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return false;
    if (!unordered) return expected.every((e, i) => deepEqual(actual[i], e, unordered, tolerance));
    // unordered: every expected item must match a different actual item
    const used = new Array(actual.length).fill(false);
    return expected.every(e => {
      const i = actual.findIndex((a, j) => !used[j] && deepEqual(a, e, unordered, tolerance));
      if (i === -1) return false;
      used[i] = true;
      return true;
    });
  }

  if (isObject(actual) && isObject(expected)) {
    const keys = Object.keys(expected);
    if (keys.length !== Object.keys(actual).length) return false;
    return keys.every(k => k in actual && deepEqual(actual[k], expected[k], unordered, tolerance));
  }

  return actual === expected;
}

// is "target" equal to "actual" or to something anywhere inside it?
function found(actual, target) {
  if (deepEqual(actual, target, true, 1e-6)) return true;
  if (Array.isArray(actual)) return actual.some(x => found(x, target));
  if (isObject(actual)) return Object.values(actual).some(x => found(x, target));
  return false;
}

function contains(actual, expected) {
  if (Array.isArray(expected)) return expected.every(e => found(actual, e));
  if (isObject(expected)) {
    return Object.entries(expected).every(([k, v]) =>
      (isObject(actual) && k in actual && contains(actual[k], v)) || found(actual, v));
  }
  return found(actual, expected);
}

// returns { ok: true } or { ok: false, reason: "..." }
export function compareAnswers(actual, expected, mode = "auto") {
  // one value asked, a list with just that value answered (["Level 1"] for "Level 1"): same answer
  if (Array.isArray(actual) && actual.length === 1 && !Array.isArray(expected)) actual = actual[0];
  let ok;
  switch (mode) {
    case "exact":
      ok = deepEqual(actual, expected, false, 1e-9);
      break;
    case "unordered":
      ok = deepEqual(actual, expected, true, 1e-9);
      break;
    case "number":
      if (!isNumber(actual)) return { ok: false, reason: `expected a number, got ${show(actual)}` };
      ok = numbersEqual(actual, expected, 1e-3);
      break;
    case "contains":
      ok = contains(actual, expected);
      break;
    case "auto":
      ok = deepEqual(actual, expected, true, 1e-6);
      break;
    default:
      return { ok: false, reason: `unknown compare mode "${mode}"` };
  }
  return ok ? { ok: true } : { ok: false, reason: `(${mode}) expected ${show(expected)} but got ${show(actual)}` };
}

// multi-part cases: expected is {"1": ..., "2": ...}; compare may be one mode or one per part
export function compareParts(actualByPart, expectedByPart, compare = "auto") {
  const failures = [];
  for (const [key, expected] of Object.entries(expectedByPart)) {
    const mode = isObject(compare) ? (compare[key] ?? "auto") : compare;
    const check = compareAnswers(actualByPart[key], expected, mode);
    if (!check.ok) failures.push(`part ${key}: ${check.reason}`);
  }
  return failures.length === 0 ? { ok: true } : { ok: false, reason: failures.join("\n") };
}