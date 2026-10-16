// Turns a DSL query (the JSON from the LLM) into Python code for the sandbox.

export function compileQuery(query) {
  if (query.return.op === "count") {
    return `result = len(model.by_type(${JSON.stringify(query.select)}))`;
  }

  throw new Error(`unsupported op: ${query.return.op}`);
}