import { readFileSync } from "fs";
import { compileQuery } from "./compiler.js";
import { loadModel, executeCode } from "../pipeline.js";
import { compareAnswers } from "../tests/compare.js";

const text = readFileSync("dsl/expected_count.json", "utf8");
const data = JSON.parse(text);

const openModels = readFileSync("tests/cases/open_models.json", "utf8");
const dataOpenModels = JSON.parse(openModels);
const cases = dataOpenModels.cases;

let counter = 0

for (const id of Object.keys(data))
{
    const c = cases.find(x => x.id === id)                        // MOVED UP: we need c.ifc_file before loading

    const loaded = await loadModel(`tests/models/${c.ifc_file}`)  // MOVED INTO the loop: each case loads its own file
    if (!loaded.success)                                          // NEW: don't run on the wrong model in silence
    {
        console.log(`${id} could not load ${c.ifc_file}: ${loaded.error}`)
        continue                                                  // skip to the next case
    }

    const query = compileQuery(data[id].dsl)
    const response = await executeCode(query)

    const compareResult = compareAnswers(response.result, c.expected, c.compare)

    if (compareResult.ok)
    {
        console.log(id + " ✔")
        counter++
    }
    else{
        console.log(id + " ✘")
    }
}

console.log(counter + "/" + Object.keys(data).length + " OK")

