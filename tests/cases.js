// Reads the test case files and works out each case's expected answer.
//
// Two formats are accepted in tests/cases/*.json:
//
// 1. One IFC file per case file:
// {
//   "ifc_file": "../models/duplex.ifc",          <- path relative to the case file
//   "cases": [
//     { "id": "count-walls", "category": "count",
//       "question": "how many walls are there?",
//       "reference_code": "result = len(model.by_type(\"IfcWall\"))",
//       "expected": 57, "compare": "auto" },
//     { "id": "multi-1", "category": "multi", "parts": 2,
//       "question": "how many doors are there and what is the IFC schema?",
//       "reference_code": "result = {\"1\": len(model.by_type(\"IfcDoor\")), \"2\": model.schema}",
//       "expected": {"1": 14, "2": "IFC4"} },
//     { "id": "refuse-1", "category": "out_of_scope",
//       "question": "write me a poem", "expect_refusal": true }
//   ]
// }
//
// 2. Several IFC files in one case file: no top-level "ifc_file", each case has its own
//    "ifc_file" with just the file name, looked up in tests/models/:
// { "cases": [ { "id": "...", "ifc_file": "walls.ifc", "question": "...", ... }, ... ] }
//
// Filters (both optional):
//   TEST_CASES=a.json,b.json   only these case files
//   TEST_IFC=walls.ifc         only the cases of this IFC file
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { executeCode } from "../pipeline.js";
import { compareAnswers } from "./compare.js";

const show = (v) => JSON.stringify(v);

// Returns one "suite" per (case file, IFC file): { file, ifcPath, cases }
export function loadCaseFiles(casesDir) {
  const onlyFiles = process.env.TEST_CASES ? process.env.TEST_CASES.split(",").map(s => s.trim()) : null;
  const onlyIfc = process.env.TEST_IFC ? process.env.TEST_IFC.split(",").map(s => s.trim()) : null;
  const modelsDir = path.resolve(casesDir, "..", "models");

  const suites = readdirSync(casesDir)
    .filter(f => f.endsWith(".json") && (!onlyFiles || onlyFiles.includes(f)))
    .sort()
    .flatMap(file => {
      const content = JSON.parse(readFileSync(path.join(casesDir, file), "utf8"));

      // format 1: one IFC file for the whole case file
      if (content.ifc_file) {
        return [{ file, ifcPath: path.resolve(casesDir, content.ifc_file), cases: content.cases }];
      }

      // format 2: group the cases by their own "ifc_file" (keeping the order they appear in)
      const byIfc = new Map();
      for (const c of content.cases) {
        if (!c.ifc_file) throw new Error(`${file}: case "${c.id}" has no "ifc_file"`);
        if (!byIfc.has(c.ifc_file)) byIfc.set(c.ifc_file, []);
        byIfc.get(c.ifc_file).push(c);
      }
      return [...byIfc].map(([ifcFile, cases]) => ({
        file,
        ifcPath: path.resolve(modelsDir, ifcFile),
        cases
      }));
    });

  return onlyIfc ? suites.filter(s => onlyIfc.includes(path.basename(s.ifcPath))) : suites;
}

// The expected answer of a case. Two sources:
//   "expected"        the value written by whoever made the test
//   "reference_code"  a correct query, run here on the same IFC file
// If both exist they MUST agree, otherwise the test itself is wrong ("bad test").
// Returns { ok: true, expected } or { ok: false, reason }
export async function resolveExpected(c) {
  if (c.expect_refusal) return { ok: true, expected: null };

  const hasWritten = c.expected !== undefined && c.expected !== null;
  if (!c.reference_code) {
    return hasWritten
      ? { ok: true, expected: c.expected }
      : { ok: false, reason: 'BAD TEST: needs "expected" or "reference_code"' };
  }

  const ref = await executeCode(c.reference_code);
  if (!ref.success) {
    return { ok: false, reason: `BAD TEST: reference_code fails: ${ref.error_type}: ${ref.error}` };
  }
  if (hasWritten) {
    const agree = compareAnswers(ref.result, c.expected, "auto");
    if (!agree.ok) {
      return {
        ok: false,
        reason: `BAD TEST: reference_code gives ${show(ref.result)} but "expected" says ${show(c.expected)}`
      };
    }
  }
  return { ok: true, expected: ref.result };
}
