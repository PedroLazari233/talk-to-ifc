// Interactive CLI: type a question, get the answer. The real work is in pipeline.js.
import readline from "readline";
import {
  ask, loadModel, IFC_PATH, LLM_MODEL, LLM_FORMAT, LLM_URL, GREEN, YELLOW, RESET
} from "./pipeline.js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function prompt() {
  rl.question("\nQuestion (or 'exit' to quit): ", async (question) => {
    if (question.trim().toLowerCase() === "exit") {
      console.log("Shutting down...");
      rl.close();
      return;
    }

    try {
      const { code, result, answers, warning } = await ask(question);
      if (code) {
        console.log("\nGenerated code:\n" + code);
      }
      if (answers) {
        console.log("\nAnswers:");
        for (const a of answers) {
          const mark = a.answered ? `${GREEN}✔${RESET}` : `${YELLOW}✘ not answered${RESET}`;
          console.log(`  ${mark} ${a.question}`);
          console.log("    ", JSON.stringify(a.answer));
        }
        if (warning) {
          console.log(`\n${YELLOW}⚠ This answer may be wrong: ${warning}${RESET}`);
        }
      } else {
        console.log("\nResult:", result);
      }
    } catch (err) {
      console.error("Error:", err.message);
    }

    prompt();
  });
}

console.log(`Loading IFC model: ${IFC_PATH}`);
console.log(`Using LLM: ${LLM_MODEL} (${LLM_FORMAT}) at ${LLM_URL}`);
const loaded = await loadModel(IFC_PATH);
if (!loaded.success) {
  console.error("Could not load the IFC file:", loaded.error);
  process.exit(1);
}
console.log("Ready! Type your questions.");
prompt();