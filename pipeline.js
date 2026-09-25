// The whole question -> answer pipeline. Used by caller.js (interactive) and the tests.
import "dotenv/config";
import path from "path";
import { appendFile } from "fs/promises";
import {
  readsModel, assignsResult, findIds, inventedGuids, answerKind, kindHint, wrongKind, isActionRequest,
  ignoredProperties, ignoredAttributes, ignoredTypes, unusedTypes, ignoredSets, doubleCounted, explainError
} from "./checks.js";

const SERVER = "http://localhost:5001";
export const IFC_PATH = process.env.IFC_PATH || "tests/models/Duplex.ifc";

// ---------- which LLM to use: set it in .env, no code changes needed ----------
// LLM_FORMAT = "openai"    -> any OpenAI-compatible API: Ollama, OpenAI, DeepSeek, Groq, vLLM/RunPod...
// LLM_FORMAT = "anthropic" -> Claude API
// defaults = local Ollama with qwen2.5:7b
export const LLM_FORMAT = (process.env.LLM_FORMAT || "openai").toLowerCase();
export const LLM_URL = process.env.LLM_URL || "http://localhost:11434/v1/chat/completions";
export const LLM_MODEL = process.env.LLM_MODEL || "qwen2.5:7b";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
// how many times to retry a wrong answer (each retry tells the model what was wrong)
const LLM_RETRIES = Number(process.env.LLM_RETRIES ?? 2);
// how long to wait for ONE LLM reply. Without a limit, a wrong URL behind a proxy or a stuck
// server just hangs forever with no message. Reasoning models can take minutes: raise it for them.
const LLM_TIMEOUT_SECONDS = Number(process.env.LLM_TIMEOUT_SECONDS ?? 300);
const LOG_FILE = "query_log.jsonl";
// below this best-example score, a (sub-)question is too far from anything we know
// (from your logs: "hi" and "send me the stir" scored ~0.18, real questions 0.57+)
const MIN_SCORE = 0.4;

// ---------- terminal colors ----------
export const RESET = "\x1b[0m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const RED = "\x1b[31m";

// ---------- reading a JSON reply safely ----------
// response.json() fails with "Unexpected token '<', "<!doctype"..." when a server sends
// an HTML page instead of JSON (a stopped RunPod pod, a crashed or old server.py...).
// This reads the text first and, if it isn't JSON, says WHO answered and WHAT they sent.
async function readJson(response, who) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`${who} answered HTTP ${response.status} with something that is not JSON: ${preview}`);
  }
}

// ---------- calls to the Python server ----------
// filled by loadModel(): a text description of what the loaded file really contains,
// and every property/quantity name found in it (for the "ignored property" check)
let modelSummaryText = "";
let modelPropertyNames = [];
let modelTypeNames = [];      // the IfcProduct types this file contains
let schemaProductTypes = {};  // every IfcProduct type of the schema -> the types above it (for ignoredTypes)

export async function loadModel(ifcPath) {
  const response = await fetch(`${SERVER}/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // a full path: the Python server may run from another folder (server/), so
    // "tests/models/Duplex.ifc" must mean the same file for both processes
    body: JSON.stringify({ ifc_path: path.resolve(ifcPath) })
  });
  const loaded = await readJson(response, "server.py /load");
  if (loaded.success) {
    modelSummaryText = await fetchModelSummary();
  }
  return loaded;
}

// asks the server which types and property/quantity sets exist in the file, and turns it into prompt text
// The summary goes into EVERY prompt, so it has to stay small. Real exports list hundreds of
// property names (Duplex, a Revit file: ~4,900 tokens; Schependomlaan, ArchiCAD: ~68,000),
// more than a small model's context: the start of the prompt (our rules) would be cut off.
// So the detail is reduced step by step until the text fits.
const SUMMARY_MAX_CHARS = 8000;   // about 2,000 tokens
const MAX_PROPS_PER_SET = 12;
// Pset_WallCommon, Qto_WallBaseQuantities... (case-sensitive: Revit's own sets are called "PSet_Revit_...")
const isStandardSet = name => /^(Pset_|Qto_)/.test(name);

// detail: "all"      -> every set with (up to 12) property names
//         "standard" -> property names only for Pset_/Qto_ sets, the other set names on one line
//         "minimal"  -> property names only for Pset_/Qto_ sets, other sets just counted
function summaryText(summary, detail) {
  const lines = [`What this model contains (${summary.schema}):`];
  for (const [type, info] of Object.entries(summary.types)) {
    // one real name per type helps map the user's words to IFC types ("canopy" -> IfcShadingDevice)
    lines.push(`- ${type}: ${info.count}${info.example_name ? ` (e.g. "${info.example_name}")` : ""}`);
    const sets = Object.entries(info.sets).sort(([a], [b]) => isStandardSet(b) - isStandardSet(a));
    const others = [];
    for (const [setName, props] of sets) {
      if (detail === "all" || isStandardSet(setName)) {
        const shown = props.filter(p => p.length <= 60).slice(0, MAX_PROPS_PER_SET);
        const more = props.length - shown.length;
        lines.push(`    ${setName}: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
      } else {
        others.push(setName);
      }
    }
    if (others.length > 0) {
      lines.push(detail === "standard"
        ? `    other sets: ${others.join(", ")}`
        : `    (+${others.length} other property sets)`);
    }
  }
  lines.push("Any IFC type not listed above has 0 elements in this model.");
  return lines.join("\n");
}

async function fetchModelSummary() {
  const response = await fetch(`${SERVER}/summary`);
  if (!response.ok) {
    // e.g. 404 from an older server.py without /summary: keep going, just without the summary
    console.warn(`Warning: could not get the model summary (HTTP ${response.status}). ` +
      "Is server.py up to date and restarted? Continuing without it.");
    return "";
  }
  const summary = await readJson(response, "server.py /summary");
  if (!summary.success) return "";

  // every property name, for the "ignored property" check (not limited like the prompt text)
  const names = new Set();
  for (const info of Object.values(summary.types)) {
    for (const props of Object.values(info.sets)) props.forEach(p => names.add(p));
  }
  modelPropertyNames = [...names];
  modelTypeNames = Object.keys(summary.types);
  schemaProductTypes = summary.product_types || {}; // an older server.py doesn't send it: the check is skipped

  for (const detail of ["all", "standard", "minimal"]) {
    const text = summaryText(summary, detail);
    if (text.length <= SUMMARY_MAX_CHARS || detail === "minimal") return text;
  }
}

// returns [{ code, description, score }]: the best example codes and the question each one answers
async function searchExamples(question, topN) {
  const response = await fetch(`${SERVER}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, top_n: topN })
  });
  const data = await readJson(response, "server.py /search");
  // success = a list of examples; a crash = {"success": false, "error": ...}
  if (!Array.isArray(data)) throw new Error(`server.py /search failed: ${data.error_type}: ${data.error}`);
  return data;
}

export async function executeCode(code) {
  const response = await fetch(`${SERVER}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code })
  });
  return readJson(response, "server.py /execute");
}

// ---------- the ONLY place that talks to the LLM ----------
// fetch with a time limit, and a clear message when the limit is hit
async function fetchLLM(options) {
  try {
    return await fetch(LLM_URL, { ...options, signal: AbortSignal.timeout(LLM_TIMEOUT_SECONDS * 1000) });
  } catch (e) {
    if (e.name === "TimeoutError") {
      throw new Error(`No answer from the LLM at ${LLM_URL} (model "${LLM_MODEL}") after ${LLM_TIMEOUT_SECONDS} s. ` +
        "Is it running, and are LLM_URL and LLM_MODEL right? A slow reasoning model may need a higher LLM_TIMEOUT_SECONDS in .env.");
    }
    throw new Error(`Could not reach the LLM at ${LLM_URL}: ${e.cause?.message ?? e.message}`);
  }
}

// messages: [{ role: "system" | "user" | "assistant", content }] -> returns the reply text
async function callLLM(messages) {
  if (LLM_FORMAT === "anthropic") {
    // Claude keeps the system prompt outside the messages list
    const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const response = await fetchLLM({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": LLM_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 2048,
        temperature: 0,
        system,
        messages: messages.filter(m => m.role !== "system")
      })
    });
    const data = await readJson(response, `LLM at ${LLM_URL}`);
    if (!response.ok) throw new Error(`LLM error ${response.status}: ${JSON.stringify(data)}`);
    return data.content[0].text;
  }

  if (LLM_FORMAT === "openai") {
    const headers = { "Content-Type": "application/json" };
    if (LLM_API_KEY) headers["Authorization"] = `Bearer ${LLM_API_KEY}`;
    const response = await fetchLLM({
      method: "POST",
      headers,
      body: JSON.stringify({ model: LLM_MODEL, temperature: 0, messages })
    });
    const data = await readJson(response, `LLM at ${LLM_URL}`);
    if (!response.ok) throw new Error(`LLM error ${response.status}: ${JSON.stringify(data)}`);
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`LLM sent no answer text: ${JSON.stringify(data).slice(0, 300)}`);
    // reasoning models (Qwen3, DeepSeek-R1...) may leave their thinking in <think>...</think>
    return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  }

  throw new Error(`Unknown LLM_FORMAT "${LLM_FORMAT}" (use "openai" or "anthropic")`);
}

// ---------- question splitting ----------
// Sentences that only say HOW to answer ("Answer with the IFC type name.", "Give the material name.",
// "Round to one decimal.") are not questions, but the splitter made parts of them - once it even
// rewrote one into a new question ("what is the IFC type name for footings?"). So they are taken
// out before splitting and added back to the last part. (Never the first sentence: that is the question.)
const FORMAT_SENTENCE = /^(answer|reply|respond|round)\b|^give (the|its|a|an) ([\w-]+ ){0,3}(name|count per [\w ]+)\.?$/i;

export function splitOffFormat(question) {
  const sentences = question.trim().split(/(?<=[.?!])\s+/);
  const format = sentences.filter((s, i) => i > 0 && FORMAT_SENTENCE.test(s));
  if (format.length === 0) return { core: question, format: "" };
  return { core: sentences.filter(s => !format.includes(s)).join(" "), format: format.join(" ") };
}

// asks the LLM to break a question into independent sub-questions
// ("list the walls and say the model name" -> ["list the walls", "what is the model name?"])
async function splitQuestion(fullQuestion) {
  const { core: question, format } = splitOffFormat(fullQuestion);
  const reply = await callLLM([
    {
      role: "system",
      content: 'Split the user question into independent sub-questions about an IFC/BIM model. ' +
        'Only split when it asks for several DIFFERENT things. Do NOT split: ' +
        'a comparison ("are there more doors than windows?" is ONE question), or ' +
        'several details of the same element ("type, name and properties of GUID X" is ONE question). ' +
        'Keep GUIDs, names and values exactly as written. ' +
        'If the message is not about a building/IFC model at all (greetings, weather, poems, travel...), return []. ' +
        'Respond ONLY with a JSON array of strings, e.g. ["how many walls are there?", "what is the name of the model?"]. ' +
        'If it is a single question, return an array with one item.'
    },
    { role: "user", content: question }
  ]);

  const raw = reply
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  let parts = null;
  try {
    const parsed = JSON.parse(raw);
    // [] means "not about the model" -> ask() refuses it
    if (Array.isArray(parsed) && parsed.every(p => typeof p === "string" && p.trim())) {
      parts = parsed.map(p => p.trim());
    }
  } catch {
    // not valid JSON -> use the fallback below
  }
  if (parts === null) return [fullQuestion]; // fallback: treat it as one question
  if (parts.length === 0) return parts;      // not about the model

  // safety net: "type, name and properties of GUID X" is about ONE element.
  // Small models split it anyway, so if every part repeats the question's only id, undo the split.
  const ids = findIds(question);
  if (parts.length > 1 && ids.length === 1 && parts.every(p => p.includes(ids[0]))) {
    return [fullQuestion];
  }
  if (format) parts[parts.length - 1] += ` ${format}`; // "... Answer with the storey name." goes back on
  return parts;
}

// searches examples for every sub-question and merges them without duplicates
async function findExamples(parts) {
  const topN = parts.length === 1 ? 2 : 1; // one question: 2 examples; several: 1 per part
  const perPart = [];
  const merged = new Map(); // code -> { description, score } of its best match (removes duplicates)

  for (const part of parts) {
    const examples = await searchExamples(part, topN);
    const best = examples.length > 0 ? examples[0].score : 0;
    perPart.push({ part, best_score: best, examples });

    if (best < MIN_SCORE) continue; // nothing close for this part: don't send noise to the LLM
    for (const ex of examples) {
      if (!merged.has(ex.code) || merged.get(ex.code).score < ex.score) {
        merged.set(ex.code, { description: ex.description, score: ex.score });
      }
    }
  }

  // The splitter already said the question is about the model (off-topic -> []), so if no example
  // is close enough, send the closest one of each part anyway instead of refusing a real question.
  // (a bad answer from a weak example is still caught by the checks)
  if (merged.size === 0) {
    for (const p of perPart) {
      const top = p.examples[0];
      if (top && !merged.has(top.code)) merged.set(top.code, { description: top.description, score: top.score });
    }
  }

  const relevantExamples = [...merged].map(([code, m]) => ({ code, description: m.description, score: m.score }));
  return { perPart, relevantExamples };
}

// ---------- code generation ----------
function cleanGeneratedCode(raw) {
  return raw
    .replace(/```python\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
}

const commonTypes = `
Common IFC types:
- IfcElement (every physical element: walls, doors, windows, stairs, slabs... use it for "all elements")
- IfcWall (wall) - standard sets: Pset_WallCommon, Qto_WallBaseQuantities
- IfcDoor (door) - Pset_DoorCommon, Qto_DoorBaseQuantities
- IfcWindow (window) - Pset_WindowCommon, Qto_WindowBaseQuantities
- IfcStair (stair) - Pset_StairCommon
- IfcSlab (slab) - Pset_SlabCommon, Qto_SlabBaseQuantities
- IfcColumn (column) - Pset_ColumnCommon, Qto_ColumnBaseQuantities
- IfcBeam (beam) - Pset_BeamCommon, Qto_BeamBaseQuantities
- IfcRoof (roof) - Pset_RoofCommon
- IfcSpace (room/space) - Pset_SpaceCommon, Qto_SpaceBaseQuantities
- IfcBuildingStorey (storey/level/floor) - NOT an IfcElement: list storeys with model.by_type("IfcBuildingStorey")
- IfcBuilding (the building), IfcSite (the site), IfcProject (the project) - three different things, each with its own Name
- IfcProduct (physical elements plus the spatial structure: site, building, storeys, spaces)
- IfcRoot (everything that has a GlobalId, including relationships and property sets)
`;

// with several parts, the answer must be a dict keyed "1", "2", ... (one key per part)
function partsInstruction(parts) {
  if (parts.length <= 1) return "";
  const list = parts.map((p, i) => {
    const hint = kindHint(answerKind(p));
    return `  "${i + 1}": ${p}${hint ? `   (answer: ${hint})` : ""}`;
  }).join("\n");
  const keys = parts.map((_, i) => `"${i + 1}"`).join(", ");
  return `
The question has ${parts.length} parts:
${list}
IMPORTANT: "result" MUST be a dict with exactly the keys ${keys}. The value of each key is the answer to that part.
Example: result = {${parts.map((_, i) => `"${i + 1}": ...`).join(", ")}}
`;
}

// checks that a multi-part answer has one key per part; returns the missing part numbers
function missingParts(parts, result) {
  if (parts.length <= 1 || !result.success) return [];
  const value = result.result;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return parts.map((_, i) => String(i + 1));
  }
  return parts.map((_, i) => String(i + 1)).filter(key => !(key in value));
}

// after every retry: the parts of a multi-part question to ask again one by one -
// every part if the code failed, else the parts with no answer or with an answer that still
// looks wrong (wrong kind: a text for "how many"; or it never uses the type the part asks about)
function weakParts(parts, code, result) {
  if (parts.length < 2) return [];
  const keys = parts.map((_, i) => String(i + 1));
  if (!result.success) return keys;
  const missing = missingParts(parts, result);
  return keys.filter((key, i) => missing.includes(key) ||
    wrongKind(parts[i], result.result[key]) !== null ||
    unusedTypes(parts[i], code, schemaProductTypes).length > 0);
}

// failedAttempt is optional: { code, problem } from the previous try
async function generateCode(question, parts, relevantExamples, idFacts, failedAttempt = null) {
  // each example is shown with the question it answers: small models copy a
  // question -> code pair much better than code alone
  const examplesText = relevantExamples
    .map(ex => `Question: ${ex.description}\nCode:\n${ex.code}`)
    .join("\n\n");

  const systemPrompt = `You write Python code that answers a question about an IFC model.
These names already exist - do not import anything:
- model: the loaded IFC file. model.by_type("IfcWall") returns all elements of a type, subtypes included (IfcWallStandardCase too - never add them up); model.by_guid("...") returns the element with that GlobalId, or None if no element has it.
- get_psets(entity): returns the property sets and quantity sets of one entity as a dict, e.g. {"Pset_WallCommon": {"IsExternal": True}}.
- duplicate_guids(): the GlobalIds that more than one entity uses, as a sorted list (empty if there are none).
- material_names(x): the names of the material (or material set) assigned to x, as a list (empty if none).
- openings(x): the openings (IfcOpeningElement) cut into x, e.g. a wall, as a list.
- fillings(x): the doors and windows placed in the openings of x (a wall, or an opening itself), as a list.
- storey_names(x): the names of the storeys x is on, as a list (empty if none).
- elements_in(place): the elements contained in a storey (or room), as a list. place can be its name: elements_in("Level 1").
  material_names, openings, fillings and storey_names accept one element or a list, e.g. material_names(model.by_type("IfcSlab")).
  For a list, material_names and storey_names give each name ONCE. To count elements per material or storey,
  call them per element: Counter(n for e in elements for n in material_names(e)).
- Counter: collections.Counter, already imported. Counter(e.is_a() for e in elements).most_common(1) gives the most frequent value.
Every entity has entity.is_a() (its IFC type), entity.Name and entity.GlobalId. Other IFC attributes are read directly too, e.g. entity.PredefinedType, entity.ObjectType, entity.Description, entity.Tag (they are NOT in get_psets).
Relationships are NOT properties either (get_psets can't see them): for storeys, materials, openings and what
fills them, use the helpers above (storey_names, elements_in, material_names, openings, fillings).
A property or attribute whose value is None or empty text ("") has no value: test it with "not value" (e.g. elements with no name: not e.Name).
"model" itself has NO .Name. The name of the model/project is model.by_type("IfcProject")[0].Name, and the IFC version is model.schema.
Store the final answer in a variable named "result".
Return the kind of value the question asks for: a number for "how many"/"count", the value itself for "which"/"what" (e.g. model.schema), and True/False only for yes/no questions.

IMPORTANT: "result" must be a plain value: string, number, boolean, None, or a list/dict of these. Never put IFC entities or sets in "result" - extract names, GlobalIds or property values instead.
IMPORTANT: never reassign "model" or "get_psets".
IMPORTANT: to get unique values use set(...), e.g. list(set(...)). Never read a variable inside the expression that creates it.
IMPORTANT: quantities such as Length, Height, Width, NetVolume, GrossVolume, NetSideArea are NOT attributes of an element (never write e.NetVolume or e.Height). Read them like properties: get_psets(e).get("Qto_WallBaseQuantities", {}).get("NetVolume").
IMPORTANT: use the property set names listed under "What this model contains". Never invent set names.
IMPORTANT: if the question names a property that is not listed (e.g. "FireRating"), still read exactly that name: no element has it, and that IS the answer. Never use a different property instead.
IMPORTANT: never invent a GUID. Use a GUID only if it is written in the question; otherwise find elements with model.by_type(...).
IMPORTANT: when you call max() or min() on a LIST that may be empty, add default=None: max(values, default=None). Never pass default to sum(), and never to max(a, b) with two separate values.
${partsInstruction(parts)}
${modelSummaryText}
${commonTypes}

Examples (a similar question and the code that answers it):
${examplesText}

Respond ONLY with Python code, no explanation, no markdown, no backticks.`;

  // single question: say up front what kind of answer it needs ("a number", "True or False"...)
  const hint = parts.length === 1 ? kindHint(answerKind(question)) : "";
  let userContent = hint ? `${question}\n\nExpected answer: ${hint}.` : question;
  if (idFacts) userContent += `\n${idFacts}`;

  // the conversation sent to the model
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent }
  ];

  // on a retry: show the model its own wrong code, then exactly what was wrong with it
  if (failedAttempt) {
    const { problem } = failedAttempt;
    const reminder = problem.crashed
      ? `\nRemember: "model" only has model.by_type(...), model.by_guid(...) and model.schema. Use only what the examples above use.`
      : "";
    messages.push({ role: "assistant", content: failedAttempt.code });
    messages.push({
      role: "user",
      content: `That code is wrong. ${problem.type}: ${problem.message}${reminder}\n` +
        `Fix it. Respond ONLY with the corrected Python code.`
    });
  }

  return cleanGeneratedCode(await callLLM(messages));
}

// ---------- the ids in the question ----------
// Asks the file which ids of the question exist. Two uses:
//  - every id is missing and the question is only about them -> we already know the answer,
//    no LLM needed (the 7B turned "not found" into True/False or crashed on None)
//  - otherwise -> a note in the prompt, so the model knows before writing code
async function checkIds(question) {
  const ids = findIds(question);
  if (ids.length === 0) return { ids, missing: [], facts: "" };
  // the ids only contain 0-9 A-Z a-z _ $, so they are safe inside a Python string
  const check = await executeCode(
    `result = {}\nfor g in ${JSON.stringify(ids)}:\n    result[g] = model.by_guid(g) is not None`
  );
  if (!check.success) return { ids, missing: [], facts: "" };
  const missing = ids.filter(id => !check.result[id]);
  const facts = ids.map(id => check.result[id]
    ? `Note: the element with GUID "${id}" exists in this model.`
    : `Note: GUID "${id}" is NOT in this model. For it, answer with the text "No element with GUID ${id} in this model".`
  ).join("\n");
  return { ids, missing, facts };
}

// ---------- checking one attempt ----------
// returns null if the attempt looks right, or { type, message, hard, crashed }:
//   hard = true  -> the answer can't be trusted at all (it crashed, was typed by hand, used an invented GUID)
//   hard = false -> the answer exists but has the wrong shape (a part is missing, or the wrong kind)
function checkAttempt(question, parts, code, result) {
  if (!result.success) {
    const hint = explainError(result.error, code);
    return {
      type: result.error_type, hard: true, crashed: true,
      message: hint ? `${result.error}. Hint: ${hint}` : result.error
    };
  }
  if (!assignsResult(code)) {
    return {
      type: "NoResult", hard: true,
      message: 'the code never stores the answer in "result" (print() shows nothing here). End with result = <the answer>.'
    };
  }
  if (!readsModel(code)) {
    return {
      type: "NotFromModel", hard: true,
      message: "the code never reads the model, so the answer was typed by hand instead of computed. " +
        "Compute it from the file with model.by_type(...) or model.by_guid(...)."
    };
  }
  const invented = inventedGuids(code, question);
  if (invented.length > 0) {
    return {
      type: "InventedGuid", hard: true,
      message: `the code uses the GUID ${invented.join(", ")}, which is not in the question. ` +
        "Never invent or copy GUIDs: to find elements of a type use model.by_type(...), " +
        "and use model.by_guid(...) only with a GUID written in the question. " +
        'To give a GUID from the model, read one: model.by_type("IfcElement")[0].GlobalId.'
    };
  }
  const missing = missingParts(parts, result);
  if (missing.length > 0) {
    return {
      type: "MissingAnswers", hard: false,
      message: `"result" has no answer for part(s) ${missing.join(", ")}. ` +
        `"result" must be a dict with keys ${parts.map((_, i) => `"${i + 1}"`).join(", ")}.`
    };
  }
  // the kind of each answer: the user's own words for a single question, each part for several
  const problems = parts.length === 1
    ? [wrongKind(question, result.result)]
    : parts.map((part, i) => wrongKind(part, result.result[String(i + 1)]));
  const wrong = problems.filter(Boolean);
  if (wrong.length > 0) {
    return { type: "WrongAnswerKind", hard: false, message: wrong.join(" ") };
  }
  const ignored = ignoredProperties(question, code, modelPropertyNames);
  if (ignored.length > 0) {
    return {
      type: "IgnoredProperty", hard: false,
      message: `the question asks about ${ignored.join(", ")}, but the code never reads it. ` +
        `Read exactly that name, e.g. get_psets(e).get("<set name>", {}).get("${ignored[0]}"). ` +
        "If no element has it, that is the answer. Never use a different property instead."
    };
  }
  const sets = ignoredSets(question, code);
  if (sets.length > 0) {
    return {
      type: "IgnoredSet", hard: false,
      message: `the question names the property set ${sets.join(", ")}, but the code never reads it. ` +
        `Use exactly that set name: get_psets(e).get("${sets[0]}", {}).get("<property>"). Never use a different set.`
    };
  }
  const types = ignoredTypes(question, code, schemaProductTypes, modelTypeNames);
  if (types.length > 0) {
    return {
      type: "IgnoredType", hard: false,
      message: `the question asks about ${types.join(", ")}, but the code never uses it. ` +
        `This model has no ${types[0]}, so model.by_type("${types[0]}") is empty - and that IS the answer ` +
        "(0, False, an empty list...). Never answer with a different type instead."
    };
  }
  const twice = doubleCounted(code, schemaProductTypes);
  if (twice) {
    return {
      type: "DoubleCounted", hard: false,
      message: `model.by_type("${twice[0]}") already includes ${twice[1]} (a subtype), so adding both counts ` +
        `those elements twice. Use model.by_type("${twice[0]}") alone.`
    };
  }
  // every part must use the type it asks about ("how many doors ...?" answered from IfcWall)
  for (const part of parts.length > 1 ? parts : [question]) {
    const unused = unusedTypes(part, code, schemaProductTypes);
    if (unused.length > 0) {
      return {
        type: "UnusedType", hard: false,
        message: `${parts.length > 1 ? `"${part}" asks` : "the question asks"} about ${unused.join(" / ")}, ` +
          `but the code never uses ${unused.length > 1 ? "any of them" : "it"}. Answer about exactly that, ` +
          `e.g. model.by_type("${unused[0]}"), filtered the way the question says.`
      };
    }
  }
  const attributes = ignoredAttributes(question, code);
  if (attributes.length > 0) {
    return {
      type: "IgnoredAttribute", hard: false,
      message: `the question asks about ${attributes.join(", ")}, an attribute of the element (not a property): ` +
        `read it directly, e.g. element.${attributes[0]}.`
    };
  }
  return null;
}

// ---------- logging ----------
async function logEntry(entry) {
  await appendFile(LOG_FILE, JSON.stringify(entry) + "\n");
}

// ---------- one question, end to end ----------
// options.quiet = true  -> no console output (batch.js prints its own progress)
// options.single = true -> don't split: treat the text as one question (used to answer parts one by one)
export async function ask(question, { quiet = false, single = false } = {}) {
  const log = quiet ? () => {} : console.log;
  const timestamp = new Date().toISOString();

  // 1. split the question into sub-questions
  const splitStart = performance.now();
  //    a request to DO something with the file (convert, email, translate...) gets no parts -> refused below
  const parts = single ? [question]
    : isActionRequest(question) ? []
    : await splitQuestion(question);
  const splitTime = performance.now() - splitStart;

  // 2. search examples for each sub-question
  const searchStart = performance.now();
  const { perPart, relevantExamples } = await findExamples(parts);
  const searchTime = performance.now() - searchStart;

  log(`\nSplit into ${parts.length} part(s):`);
  for (const p of perPart) {
    const label = p.best_score >= MIN_SCORE ? `${GREEN}MATCH${RESET}` : `${YELLOW}NO MATCH${RESET}`;
    const firstLine = p.examples.length > 0 ? p.examples[0].code.split("\n")[0] : "-";
    log(`  [${label}] "${p.part}" (best ${p.best_score.toFixed(2)}) — ${firstLine}`);
  }

  const unmatchedParts = perPart.filter(p => p.best_score < MIN_SCORE).map(p => p.part);

  const baseEntry = {
    timestamp,
    question,
    sub_questions: perPart.map(p => ({
      part: p.part,
      best_score: p.best_score,
      examples: p.examples.map(ex => ({ description: ex.description, code: ex.code, score: ex.score }))
    })),
    unmatched_parts: unmatchedParts
  };

  // the splitter said it's not about the model ([]), or there are no examples at all -> don't guess
  if (parts.length === 0 || relevantExamples.length === 0) {
    const result = {
      success: false,
      error: parts.length === 0
        ? "I can only answer questions about what is in the IFC model: I can't change, convert, export or send it, and I can't help with other topics."
        : "I couldn't match this question to anything I know. Try rephrasing it.",
      error_type: "NoMatch"
    };
    await logEntry({
      ...baseEntry,
      generated_code: null,
      first_error: null,
      attempts: 0,
      remaining_problem: null,
      result,
      timing_ms: {
        split: Math.round(splitTime),
        search: Math.round(searchTime),
        generate_and_execute: 0,
        total: Math.round(splitTime + searchTime)
      }
    });
    return {
      code: null, result, answers: null, parts, firstError: null, attempts: 0, warning: null,
      totalMs: Math.round(splitTime + searchTime)
    };
  }

  if (unmatchedParts.length > 0) {
    log(`${YELLOW}Warning: no close example for: ${unmatchedParts.join(" | ")} — using the closest one anyway.${RESET}`);
  }

  // 3. GUIDs in the question: if the question is only about elements that are not in the file,
  //    the answer is already known - don't ask the LLM
  const generateStart = performance.now();
  const idCheck = await checkIds(question);
  const onlyAboutMissing = idCheck.ids.length > 0 && idCheck.missing.length === idCheck.ids.length &&
    (parts.length === 1 || parts.every(p => idCheck.ids.some(id => p.includes(id))));
  if (onlyAboutMissing) {
    const message = `No element with GUID ${idCheck.missing.join(", ")} in this model`;
    // "does element X exist?" -> False, "how many elements have GUID X?" -> 0, anything else -> the message
    const answerFor = text => ({ "yes/no": false, count: 0 })[answerKind(text)] ?? message;
    const answers = parts.length === 1
      ? [{ question: parts[0], answer: answerFor(question), answered: true }]
      : parts.map(part => ({ question: part, answer: answerFor(part), answered: true }));
    const result = {
      success: true,
      result: parts.length === 1 ? answers[0].answer : Object.fromEntries(answers.map((a, i) => [String(i + 1), a.answer]))
    };
    const totalMs = Math.round(splitTime + searchTime + (performance.now() - generateStart));
    log(`\n${GREEN}Answered from the file directly: the GUID is not in the model.${RESET}`);
    await logEntry({
      ...baseEntry, generated_code: null, first_error: null, attempts: 0, remaining_problem: null,
      answered_without_llm: true, result, answers,
      timing_ms: { split: Math.round(splitTime), search: Math.round(searchTime), generate_and_execute: 0, total: totalMs }
    });
    return { code: null, result, answers, parts, firstError: null, attempts: 0, warning: null, totalMs };
  }
  const idFacts = idCheck.facts;

  // 4. generate + execute + check, retrying with the exact problem up to LLM_RETRIES times
  let code = null;
  let result = null;
  let problem = null;
  let firstError = null;
  let bestSoft = null; // the last attempt that ran and read the model, even if its shape was off
  let attempts = 0;

  for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
    attempts++;
    const previous = problem ? { code, problem } : null;
    code = await generateCode(question, parts, relevantExamples, idFacts, previous);
    result = await executeCode(code);
    problem = checkAttempt(question, parts, code, result);

    if (!problem) break;
    if (!problem.hard) bestSoft = { code, result, problem };
    if (!firstError) firstError = `${problem.type}: ${problem.message}`;
    if (attempt < LLM_RETRIES) log(`\nTry ${attempt + 1} was wrong (${problem.type}), retrying...`);
  }

  // still wrong after every retry:
  //  - a hard problem at the end, but an earlier try only had a shape problem -> keep that earlier answer
  //  - a hard problem and nothing better -> no answer at all (never show an invented one)
  if (problem && problem.hard) {
    if (bestSoft) {
      ({ code, result, problem } = bestSoft);
    } else {
      result = { success: false, error_type: problem.type, error: problem.message };
    }
  }

  // 5. a multi-part question with parts still unanswered or doubtful - it crashed, "result" lacks
  //    some keys (the 7B once returned one number for 4 parts), or a part's answer still looks
  //    wrong (weakParts): ask those parts again, one by one.
  //    One question per call is easier for a small model than one dict for every part,
  //    and a part it can't answer no longer takes the others down with it.
  let partAnswers = null;
  let partWarnings = [];
  const unanswered = weakParts(parts, code, result);
  if (unanswered.length > 0) {
    log(`\n${YELLOW}Part(s) ${unanswered.join(", ")} got no answer or a doubtful one` +
      `${result.success ? "" : ` (${result.error_type})`}, answering them one by one...${RESET}`);
    const value = result.success ? result.result : null;
    const answeredTogether = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const codes = result.success ? [`# the parts answered together\n${code}`] : [];
    const failed = [];
    partAnswers = [];
    for (const [i, part] of parts.entries()) {
      const key = String(i + 1);
      if (!unanswered.includes(key)) {
        partAnswers.push({ question: part, answer: answeredTogether[key], answered: true });
        continue;
      }
      const sub = await ask(part, { quiet: true, single: true });
      attempts += sub.attempts;
      if (sub.result.success) {
        if (sub.warning) partWarnings.push(`part ${key}: ${sub.warning}`);
        codes.push(`# part ${key}: ${part}\n${sub.code}`);
        partAnswers.push({ question: part, answer: sub.answers[0].answer, answered: true });
      } else if (key in answeredTogether) {
        // asked alone it failed: keep the doubtful answer from the combined try, flagged
        partWarnings.push(`part ${key}: this answer may be wrong (it failed when asked on its own)`);
        partAnswers.push({ question: part, answer: answeredTogether[key], answered: true });
      } else {
        failed.push(`part ${key}: ${sub.result.error_type}`);
        codes.push(`# part ${key}: ${part}\n# (no code)`);
        partAnswers.push({ question: part, answer: null, answered: false });
      }
    }
    if (partAnswers.some(a => a.answered)) {
      result = { success: true, result: Object.fromEntries(partAnswers.map((a, i) => [String(i + 1), a.answer])) };
      code = codes.join("\n\n");
      problem = failed.length > 0 ? { type: "SomePartsFailed", hard: false, message: failed.join(", ") } : null;
    } else {
      partAnswers = null; // nothing better: keep what the combined attempt gave
    }
  }
  const generateTime = performance.now() - generateStart;

  // an answer whose shape still looks wrong after every retry is shown, but flagged
  const warning = partAnswers
    ? (partWarnings.length > 0 ? partWarnings.join(" ") : null)
    : (problem && !problem.hard && problem.type !== "MissingAnswers" ? problem.message : null);

  // one answer per sub-question (for a single question: the whole result)
  const stillMissing = missingParts(parts, result);
  let answers = null;
  if (partAnswers && result.success) {
    answers = partAnswers;
  } else if (result.success) {
    answers = parts.length === 1
      ? [{ question: parts[0], answer: result.result, answered: true }]
      : parts.map((part, i) => {
          const key = String(i + 1);
          const answered = !stillMissing.includes(key);
          return { question: part, answer: answered ? result.result[key] : null, answered };
        });
  }

  await logEntry({
    ...baseEntry,
    examples_sent: relevantExamples.map(ex => ({ description: ex.description, code: ex.code, score: ex.score })),
    id_facts: idFacts || null,
    generated_code: code,
    first_error: firstError,
    attempts,
    remaining_problem: problem ? `${problem.type}: ${problem.message}` : null,
    result,
    answers,
    timing_ms: {
      split: Math.round(splitTime),
      search: Math.round(searchTime),
      generate_and_execute: Math.round(generateTime),
      total: Math.round(splitTime + searchTime + generateTime)
    }
  });

  return {
    code, result, answers, parts, firstError, attempts, warning,
    totalMs: Math.round(splitTime + searchTime + generateTime)
  };
}