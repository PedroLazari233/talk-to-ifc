// Checks the test cases THEMSELVES, without calling the LLM (fast).
// Use it right after an AI generates a case file, before running the real tests:
//   - every reference_code runs without errors on its IFC file
//   - reference_code and "expected" agree
//   - every case has the fields it needs
//
// run:  node tests/check_cases.js            (all files in tests/cases)
//       TEST_CASES=duplex.json node tests/check_cases.js
import path from "path";
import { fileURLToPath } from "url";
import { loadModel, GREEN, RED, YELLOW, RESET } from "../pipeline.js";
import { loadCaseFiles, resolveExpected } from "./cases.js";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
let bad = 0;
let total = 0;

for (const suite of loadCaseFiles(path.join(testsDir, "cases"))) {
  console.log(`\n${suite.file}  ->  ${suite.ifcPath}`);
  const loaded = await loadModel(suite.ifcPath);
  if (!loaded.success) {
    console.log(`${RED}  cannot load the IFC file: ${loaded.error}${RESET}`);
    bad += suite.cases.length;
    total += suite.cases.length;
    continue;
  }

  const ids = new Set();
  for (const c of suite.cases) {
    total++;
    const problems = [];
    if (!c.id) problems.push('missing "id"');
    else if (ids.has(c.id)) problems.push(`duplicate id "${c.id}"`);
    ids.add(c.id);
    if (!c.question) problems.push('missing "question"');
    if ((c.parts ?? 1) > 1 && c.expected && typeof c.expected === "object" &&
        Object.keys(c.expected).length !== c.parts) {
      problems.push(`"parts" is ${c.parts} but "expected" has ${Object.keys(c.expected).length} keys`);
    }

    const exp = await resolveExpected(c);
    if (!exp.ok) problems.push(exp.reason);

    if (problems.length > 0) {
      bad++;
      console.log(`${RED}  ✘ ${c.id}${RESET}: ${c.question}`);
      for (const p of problems) console.log(`      ${p}`);
    } else {
      const note = c.expect_refusal ? "(should be refused)"
        : (c.expected === undefined || c.expected === null)
          ? `${YELLOW}(no written expected: reference_code result used, review it)${RESET}` : "";
      console.log(`${GREEN}  ✔ ${c.id}${RESET} ${note}`);
    }
  }
}

console.log(`\n${total - bad} / ${total} cases OK, ${bad} need fixing.`);
process.exit(bad > 0 ? 1 : 0);
