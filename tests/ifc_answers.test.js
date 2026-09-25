// End-to-end answer tests: every case in tests/cases/*.json goes through the real pipeline
// (split -> search -> LLM -> execute) and the answer is compared with the expected one.
//
// run all:             node --test tests/ifc_answers.test.js
// one case file:       TEST_CASES=duplex.json node --test tests/ifc_answers.test.js
// cases by name:       node --test --test-name-pattern="count" tests/ifc_answers.test.js
//
// needs server.py and the LLM running. A report of every case is written to tests/reports/.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ask, loadModel, LLM_MODEL, LLM_FORMAT, LLM_URL } from "../pipeline.js";
import { compareAnswers, compareParts } from "./compare.js";
import { loadCaseFiles, resolveExpected } from "./cases.js";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const show = (v) => JSON.stringify(v);
const report = [];

// first thing on screen: which model this run uses
console.log(`LLM: ${LLM_MODEL} (${LLM_FORMAT}) at ${LLM_URL}`);

for (const suite of loadCaseFiles(path.join(testsDir, "cases"))) {
  // suites run one after another, so the server has the right IFC file loaded for each
  describe(`${suite.file} (${path.basename(suite.ifcPath)})`, () => {
    before(async () => {
      const loaded = await loadModel(suite.ifcPath);
      if (!loaded.success) throw new Error(`could not load ${suite.ifcPath}: ${loaded.error}`);
    });

    for (const c of suite.cases) {
      test(`[${c.category ?? "-"}] ${c.id}: ${c.question}`, async () => {
        const row = { model: LLM_MODEL, file: suite.file, id: c.id, category: c.category ?? null, question: c.question };
        report.push(row);

        // 1. what the answer should be
        const exp = await resolveExpected(c);
        row.expected = exp.expected;
        if (!exp.ok) {
          row.status = "bad_test";
          row.reason = exp.reason;
          assert.fail(exp.reason);
        }

        // 2. what the pipeline answers
        const out = await ask(c.question, { quiet: true });
        row.parts = out.parts;
        row.code = out.code;
        row.first_error = out.firstError;
        row.attempts = out.attempts;
        row.warning = out.warning;
        row.total_ms = out.totalMs;

        // 3. compare
        let check;
        if (c.expect_refusal) {
          row.actual = out.result;
          check = out.result.error_type === "NoMatch"
            ? { ok: true }
            : { ok: false, reason: `should have refused, but answered ${show(out.result)}` };
        } else if (!out.result.success) {
          row.actual = out.result;
          check = { ok: false, reason: `pipeline failed: ${out.result.error_type}: ${out.result.error}` };
        } else if ((c.parts ?? 1) > 1) {
          // multi-part: one expected value per part, keys "1", "2", ...
          const actualByPart = Object.fromEntries(out.answers.map((a, i) => [String(i + 1), a.answer]));
          row.actual = actualByPart;
          check = out.parts.length !== c.parts
            ? { ok: false, reason: `split into ${out.parts.length} parts ${show(out.parts)}, expected ${c.parts}` }
            : compareParts(actualByPart, exp.expected, c.compare ?? "auto");
        } else {
          // single question (if the splitter split it anyway, compare against the whole result)
          row.actual = out.parts.length === 1 ? out.answers[0].answer : out.result.result;
          check = compareAnswers(row.actual, exp.expected, c.compare ?? "auto");
        }

        row.status = check.ok ? "pass" : "fail";
        row.reason = check.ok ? null : check.reason;
        assert.ok(check.ok, `${check.reason}\n  generated code:\n${out.code}`);
      });
    }
  });
}

// after everything: summary per category + a JSONL report to send for analysis
after(() => {
  if (report.length === 0) return;
  const reportsDir = path.join(testsDir, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // the model in the name, to compare runs of different models ("Qwen/Qwen3.8-27B-FP8" -> "Qwen-Qwen3.8-27B-FP8";
  // ":" and "/" are not allowed in Windows file names)
  const modelTag = LLM_MODEL.replace(/[^A-Za-z0-9._-]+/g, "-");
  const file = path.join(reportsDir, `report_${stamp}_${modelTag}.jsonl`);
  writeFileSync(file, report.map(r => JSON.stringify(r)).join("\n") + "\n");

  const count = (rows, status) => rows.filter(r => r.status === status).length;
  const lines = ["", "================ ANSWER TEST SUMMARY ================", `model: ${LLM_MODEL}`];
  lines.push(`pass ${count(report, "pass")} / ${report.length}   fail ${count(report, "fail")}   bad tests ${count(report, "bad_test")}`);
  lines.push("by category (pass / total):");
  for (const cat of [...new Set(report.map(r => r.category ?? "-"))].sort()) {
    const rows = report.filter(r => (r.category ?? "-") === cat);
    lines.push(`  ${cat.padEnd(20)} ${count(rows, "pass")} / ${rows.length}`);
  }
  lines.push(`report: ${file}`);
  console.log(lines.join("\n"));
});