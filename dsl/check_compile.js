import { readFileSync } from "fs";
import { compileQuery } from "./compiler.js";

const text = readFileSync("dsl/expected_count.json", "utf8");
const data = JSON.parse(text);

for (const d of Object.keys(data))
{
    console.log(d + " = " + compileQuery(data[d].dsl))
}
