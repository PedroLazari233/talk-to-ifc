// checks.js - rules that spot a wrong answer WITHOUT asking an LLM.
// When a rule fires, pipeline.js retries and tells the model exactly what was wrong.
// Small models ignore long lists of rules in a prompt, but they fix one precise error well.
// Each rule only fires on CLEAR mistakes: a false alarm costs a retry, a miss costs nothing new.

// ---------- the answer must come from the model ----------
// A small model sometimes "answers" by typing values by hand, e.g.
// result = {"type": "IfcStair", "name": "Stair 1"} -- invented, but it runs fine.
// Every real answer has to read the IFC file, so code that never uses "model" is rejected.
// the answer must be stored in "result" (print() does nothing in the sandbox)
export function assignsResult(code) {
  return /\bresult\s*=(?!=)/.test(code);
}

export function readsModel(code) {
  // the helpers read the file too: result = len(elements_in("Level 1")) never names "model"
  return /\bmodel\b/.test(code) ||
    /\b(duplicate_guids|elements_in|storey_names|material_names|openings|fillings)\s*\(/.test(code);
}

// ---------- GUIDs ----------
// an IFC GlobalId is exactly 22 characters from: 0-9 A-Z a-z _ $
const GUID_TOKEN = /(?<![0-9A-Za-z_$])[0-9A-Za-z_$]{22}(?![0-9A-Za-z_$])/g;
// some IFC names are also 22 characters long (e.g. Qto_WallBaseQuantities) -> not GUIDs
const IFC_NAME_PREFIXES = ["ifc", "pset_", "qto_"];
// the UUID style that models like to invent, e.g. 2C7F6C6F-6B6F-4B6D-AF6F-6F6F6F6F6F
const UUID_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{6,12}/gi;

function isIfcName(token) {
  const lower = token.toLowerCase();
  return IFC_NAME_PREFIXES.some(prefix => lower.startsWith(prefix));
}

// the ids written in a question. Looser than a real GlobalId (20 to 24 characters):
// people paste ids with a typo, and ChatGPT-made test ids are often 23 long.
const ID_TOKEN = /(?<![0-9A-Za-z_$])[0-9A-Za-z_$]{20,24}(?![0-9A-Za-z_$])/g;

export function findIds(text) {
  const tokens = (text.match(ID_TOKEN) || [])
    .filter(t => !isIfcName(t) && /[0-9]/.test(t) && /[A-Za-z]/.test(t));
  return [...new Set(tokens)];
}

// GUIDs inside the code's strings that the question never mentioned:
// the model invented them, or copied the one from an example
export function inventedGuids(code, question) {
  const invented = new Set();
  for (const [, literal] of code.matchAll(/["']([^"'\n]*)["']/g)) { // every "..." or '...' in the code
    const tokens = [
      // 22 characters with a digit or $: property names (22 letters) are not GUIDs
      ...(literal.match(GUID_TOKEN) || []).filter(t => !isIfcName(t) && /[0-9$]/.test(t)),
      ...(literal.match(UUID_TOKEN) || [])
    ];
    for (const token of tokens) {
      if (!question.includes(token)) invented.add(token);
    }
  }
  return [...invented];
}

// ---------- the KIND of answer a question asks for ----------
// read from the wording only:
//   "count"   -> "how many ...?"                      the answer must be a number (or counts per type)
//   "choice"  -> "which ..., A or B?" / "is this A or B?" the answer is the option, not True/False or a number
//   "yes/no"  -> "is there ...?" / "check whether ..."   True/False expected; a bare number is rejected
//   "number"  -> "what is the total/average/largest <quantity>?"   one number, not a dict of stats
//   "value"   -> "what/which/list/show/find/compare ..." anything except True/False
//   "unknown" -> no rule
export function answerKind(question) {
  const q = question.trim().toLowerCase()
    .replace(/^(can|could|would) you (please )?/, "") // "can you count..." is a request, not a yes/no
    .replace(/^please /, "");

  if (/^which\b/.test(q) && /\bor\b/.test(q)) return "choice";
  if (/^(is|are) (this|the|it)\b.*\bor\b/.test(q)) return "choice";
  if (/\bhow many\b/.test(q) || /^count\b/.test(q)) return "count";
  if (/^(is|are|does|do|did|has|have|was|were|will|should|whether|if)\b/.test(q)) return "yes/no";
  if (/^(check|tell me|verify|confirm|see)\s+(if|whether)\b/.test(q)) return "yes/no";
  // "what is the total net volume", "give me the average wall height": ONE number
  // (only for these openings: "which wall is the largest?" wants a name, "compare..." wants both)
  if (/^(what|whats|what's|give|calculate|compute|get|sum|total|average|tell me the)\b/.test(q) &&
      !/\b(name|names|guid|globalid|type)\b/.test(q) &&  // "the NAME of the largest room" is not a number
      /\b(total|sum|average|mean|largest|smallest|maximum|minimum|highest|lowest)\b/.test(q) &&
      /(length|height|width|volume|area|thickness|depth|perimeter)/.test(q)) return "number";
  // "tell me" alone (not "tell me if/whether", handled above): "tell me the project name", "tell me everything about X"
  if (/^(which|what|list|show|give|find|compare|name|get|calculate|compute|sum|report|identify|tell me)\b/.test(q)) {
    // "what is the IsExternal value of ...?" can honestly be True/False
    if (/\b(value|values|property|properties|true|false)\b/.test(q)) return "unknown";
    return "value";
  }
  return "unknown";
}

// a short hint for the prompt, so the model aims right the first time
export function kindHint(kind) {
  return {
    count: "a number",
    number: "one number",
    choice: "the option that matches (its name or value), not True/False and not a count",
    "yes/no": "True or False",
    value: "the value(s) asked for, not True/False"
  }[kind] || "";
}

function describe(value) {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return `the number ${value}`;
  if (typeof value === "string") return `the text "${value.slice(0, 40)}"`;
  if (Array.isArray(value)) return "a list";
  return "a dict";
}

// the two options of "..., A or B?" at the end of a question, or null
function choiceOptions(question) {
  const match = question.trim().match(/([\w.$-]+)\s+or\s+([\w.$-]+)\s*\??\s*$/i);
  return match ? [match[1], match[2]] : null;
}

// returns a message if the answer is clearly the wrong KIND for the question, else null
export function wrongKind(question, answer) {
  const kind = answerKind(question);
  const isNumber = typeof answer === "number";
  const isBool = typeof answer === "boolean";
  const isList = Array.isArray(answer);
  const isDict = answer !== null && typeof answer === "object" && !isList;

  // "the distinct ... values": each value once, and no None (an element WITHOUT the value is not a value)
  if (/\b(distinct|unique|different)\b/i.test(question) && isList && answer.length > 0) {
    const hasNone = answer.some(a => a === null || a === undefined);
    const texts = answer.map(a => JSON.stringify(a));
    const repeats = new Set(texts).size < texts.length;
    if (hasNone || repeats) {
      const what = [repeats && "repeats values", hasNone && "contains None"].filter(Boolean).join(" and ");
      return `"${question}" asks for distinct values, but the list ${what}. ` +
        "Keep each value once and leave out None: sorted(set(v for v in values if v is not None)).";
    }
  }
  // "which types ...?" never needs the same type twice
  if (/\b(types?|kinds?)\b/i.test(question) && isList && answer.length > 1 &&
      answer.every(a => typeof a === "string") && new Set(answer).size < answer.length) {
    return `"${question}" asks which types, but the list repeats the same type. ` +
      `Return each type once, e.g. sorted(set(...)).`;
  }
  if (kind === "count" && !isNumber && !isDict) {
    return `"${question}" asks HOW MANY, so its answer must be a number (e.g. len(...)), but it was ${describe(answer)}.`;
  }
  if (kind === "yes/no" && isNumber) {
    // "are there any beams?" -> 0 is a count, not an answer (a list or a text still carries the yes/no)
    return `"${question}" is a yes/no question, so answer True or False (e.g. len(...) > 0), not ${describe(answer)}.`;
  }
  if (kind === "number" && !isNumber && answer !== null && answer !== undefined) {
    return `"${question}" asks for ONE number, so its answer must be a number (e.g. sum(values)), ` +
      `but it was ${describe(answer)}.`;
  }
  if (kind === "choice") {
    // choosing between two IFC names ("IfcBeam or IfcColumn", "IFC2x3 or IFC4"): the answer must name one
    const options = choiceOptions(question);
    const betweenIfcNames = options !== null && options.every(o => /^ifc/i.test(o));
    if (isBool || isNumber || (betweenIfcNames && (isList || answer === null || answer === undefined))) {
      return `"${question}" asks WHICH of the options it names, so answer with the option that matches ` +
        `as text (e.g. "IfcBeam" or model.schema), or "equal" if they tie - not ${describe(answer)}.`;
    }
  }
  if (kind === "value" && isBool) {
    return `"${question}" is not a yes/no question, so ${describe(answer)} is not an answer. ` +
      `Return what it asks for: a name, a number, a list, or a dict with the values.`;
  }
  return null;
}

// ---------- properties the question names ----------
// Common IFC property and quantity names, so we recognise them even when THIS model doesn't have them.
// (walls.ifc has no FireRating; a small model then "answers" with IsExternal instead)
export const COMMON_PROPERTIES = [
  "FireRating", "IsExternal", "LoadBearing", "ThermalTransmittance", "AcousticRating", "Combustible",
  "SurfaceSpreadOfFlame", "Compartmentation", "HandicapAccessible", "FireExit", "SelfClosing", "SmokeStop",
  "SecurityRating", "GlazingAreaFraction", "NumberOfRiser", "NumberOfTreads", "RiserHeight", "TreadLength",
  "Length", "Height", "Perimeter", "NetVolume", "GrossVolume", "NetSideArea", "GrossSideArea",
  "NetArea", "GrossArea", "NetFootprintArea", "GrossFootprintArea"
];
// names that are also ordinary words in questions ("reference", "status"...) -> not checked
const NOT_CHECKED = new Set(["reference", "status", "description", "category", "comments", "family"]);

const squash = text => text.toLowerCase().replace(/[^a-z0-9]/g, ""); // "fire rating" -> "firerating"

// property names the question mentions but the code never reads.
//  - the common IFC names above match loosely: "fire rating", "fire-rating", "FireRating"
//  - names read from THIS file only match with their exact spelling, because exports use plain words
//    as property names ("Project Name", "Number", "TotalArea"): "what is the project name?" or
//    "the total area of the rooms" must not demand them
export function ignoredProperties(question, code, modelNames = []) {
  const q = squash(question);
  const found = [];
  for (const name of COMMON_PROPERTIES) {
    const key = squash(name);
    if (key.length >= 6 && !NOT_CHECKED.has(key) && q.includes(key)) found.push(name);
  }
  for (const name of new Set(modelNames)) {
    if (name.length < 6 || NOT_CHECKED.has(squash(name))) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`).test(question)) found.push(name);
  }
  const codeLower = code.toLowerCase();
  const ignored = [...new Set(found)].filter(name => !codeLower.includes(name.toLowerCase()));
  // "riser height" matches RiserHeight and Height: report only the longest
  return ignored.filter(n => !ignored.some(m => m !== n && squash(m).includes(squash(n))));
}

// ---------- element types the question names ----------
// "Are there any pipe segments?" in a model without pipes: the 7B answered with IfcDuctSegment,
// the closest type it saw in the model summary. Same idea as ignoredProperties: a type the question
// names that the model does NOT contain must still be used - its empty result IS the answer.
// (Only for types missing from the model: that is when the model swaps in another one.)

// words that are also IFC type names but usually mean something else in a question
const NOT_TYPES = new Set(["filter", "bearing", "course"]); // "filter the walls", "load-bearing", "of course"
// everyday words for a type whose IFC name is different (the first one the schema has is used)
const TYPE_WORDS = {
  room: ["IfcSpace"],
  opening: ["IfcOpeningElement"],
  furniture: ["IfcFurniture", "IfcFurnishingElement"], // IFC2X3 has no IfcFurniture
};

function singularForms(word) {
  const forms = [word];
  if (word.endsWith("ies")) forms.push(word.slice(0, -3) + "y");   // proxies -> proxy
  if (word.endsWith("es")) forms.push(word.slice(0, -2));          // boxes -> box
  if (word.endsWith("s")) forms.push(word.slice(0, -1));           // walls -> wall
  return forms;
}

// productTypes: { "IfcPipeSegment": ["IfcProduct", ..., "IfcFlowSegment"], ... } from server.py /summary
// returns the IFC types the question names: "pipe segments" -> IfcPipeSegment, "IfcDoor" -> IfcDoor
export function typesInQuestion(question, productTypes) {
  const byLower = new Map(Object.keys(productTypes).map(t => [t.toLowerCase(), t]));
  const text = question.replace(/(["'])[^"'\n]*\1/g, " ");  // quoted names ('road rail bridge') are names, not types
  const words = text.toLowerCase().match(/[a-z]+/g) || [];

  // types written out ("pavement courses (IfcCourse)") say exactly what is meant: trust only those
  const written = words.filter(w => w.startsWith("ifc") && byLower.has(w)).map(w => byLower.get(w));
  if (written.length > 0) return [...new Set(written)];

  const used = new Array(words.length).fill(false);
  const spans = []; // [start, end, type]
  for (let size = 3; size >= 1; size--) {          // longest first: "building storey" before "building"
    for (let i = 0; i + size <= words.length; i++) {
      if (used.slice(i, i + size).some(Boolean)) continue;
      const group = words.slice(i, i + size);
      if (size === 1 && NOT_TYPES.has(group[0])) continue;
      for (const last of singularForms(group[size - 1])) {
        const type = byLower.get("ifc" + [...group.slice(0, -1), last].join("")) ||
          (size === 1 && Object.hasOwn(TYPE_WORDS, last) ? TYPE_WORDS[last].find(t => t in productTypes) : undefined);
        if (type) {
          spans.push([i, i + size, type]);
          used.fill(true, i, i + size);
          break;
        }
      }
    }
  }
  // "roof windows", "pavement courses": the first word only describes the second -> keep the last one
  const found = spans.filter(([, end]) => !spans.some(([start]) => start === end)).map(([, , type]) => type);
  return [...new Set(found)];
}

// types the question names, that this model does not contain, and that the code never uses
// (using a type above or below it counts: IfcElement filtered with is_a, IfcWallStandardCase for walls)
export function ignoredTypes(question, code, productTypes, modelTypes) {
  if (!productTypes || Object.keys(productTypes).length === 0) return [];
  const inModel = new Set(modelTypes);
  const codeLower = code.toLowerCase();
  const mentions = type => new RegExp(`\\b${type.toLowerCase()}\\b`).test(codeLower);
  return typesInQuestion(question, productTypes).filter(type => {
    if (inModel.has(type)) return false;
    const above = productTypes[type] || [];
    const below = Object.keys(productTypes).filter(t => (productTypes[t] || []).includes(type));
    return ![type, ...above, ...below].some(mentions);
  });
}

// types the question names that the code never uses at all, even when the model has them:
// "how many doors are on Level 2?" answered with len(model.by_type("IfcWall")) after a crash,
// "which are the 3 largest rooms?" answered with the storey names. Any ONE of the named types is
// enough ("windows on the Roof storey" names IfcWindow and IfcRoof), and so is a type below it
// (IfcWallStandardCase for walls) or a specific type above it (IfcFurnishingElement for furniture) -
// but not a catch-all like IfcElement: by_type("IfcElement") alone does not count doors.
const CATCH_ALL = new Set(["IfcProduct", "IfcElement", "IfcBuildingElement", "IfcBuiltElement",
  "IfcSpatialElement", "IfcSpatialStructureElement"]);

export function unusedTypes(question, code, productTypes) {
  if (!productTypes || Object.keys(productTypes).length === 0) return [];
  const named = typesInQuestion(question, productTypes);
  if (named.length === 0) return [];
  const codeLower = code.toLowerCase();
  const mentions = type => new RegExp(`\\b${type.toLowerCase()}\\b`).test(codeLower);
  const used = named.some(type => {
    const above = (productTypes[type] || []).filter(t => !CATCH_ALL.has(t));
    const below = Object.keys(productTypes).filter(t => (productTypes[t] || []).includes(type));
    return [type, ...above, ...below].some(mentions);
  });
  return used ? [] : named;
}

// ---------- a type counted twice ----------
// by_type("IfcWall") already returns the subtypes (IfcWallStandardCase...). Even the 27B wrote
// len(model.by_type("IfcWall")) + len(model.by_type("IfcWallStandardCase")) -> 113 walls instead of 57.
// Returns [type, subtype] when the code adds a type and one of its subtypes, else null.
export function doubleCounted(code, productTypes) {
  if (!productTypes) return null;
  const byLower = new Map(Object.keys(productTypes).map(t => [t.toLowerCase(), t]));
  const isBelow = (sub, sup) => (productTypes[byLower.get(sub.toLowerCase())] || [])
    .some(t => t.toLowerCase() === sup.toLowerCase());
  // only counts added up: a list sum (by_type(A) + by_type(B)) may be de-duplicated afterwards, as the 27B did
  const added = /len\(\s*model\.by_type\(\s*["'](\w+)["']\s*\)\s*\)\s*\+\s*len\(\s*model\.by_type\(\s*["'](\w+)["']/g;
  for (const [, a, b] of code.matchAll(added)) {
    if (isBelow(b, a)) return [a, b];
    if (isBelow(a, b)) return [b, a];
  }
  return null;
}

// ---------- property sets the question names ----------
// "the total Length of all railings, using PSet_Revit_Dimensions" answered from "PSet_RailingCommon"
// (a set that does not even exist): a set written in the question must be read by the code.
export function ignoredSets(question, code) {
  const sets = question.match(/\b(?:pset|qto)_[A-Za-z0-9_]+/gi) || [];
  const codeLower = code.toLowerCase();
  return [...new Set(sets)].filter(name => !codeLower.includes(name.toLowerCase()));
}

// ---------- turning a Python error into a fix ----------
// A small model reads "'NoneType' object has no attribute 'file'" and tries the same thing again.
// These hints say what the error means and how to fix it.
export function explainError(message, code) {
  const hints = [
    [/'NoneType'/.test(message) && /by_guid/.test(code),
      'model.by_guid(...) returned None: that GUID is not in this model. Check "if element is None" before using it, ' +
      'and then answer that it was not found, e.g. result = "No element with GUID ... in this model".'],
    [/'NoneType'/.test(message),
      "a value was None (a property that is missing, or an empty result). Check for None before using it."],
    [/Generator expression must be parenthesized/.test(message),
      "a generator next to another argument needs its own parentheses: sum((x for x in items), 0). " +
      "Or use a list: sum([x for x in items])."],
    [/expected 'else' after 'if' expression/.test(message),
      "a one-line if needs an else: a if condition else b."],
    [/'SafeModel' object is not iterable/.test(message),
      'model is the whole file, not a list: get its entities with model.by_type("IfcRoot") (or another type).'],
    [/name 'Ifc\w*' is not defined/.test(message),
      'IFC type names are text: write model.by_type("IfcRoot"), with quotes.'],
    [/'(float|int|str|bool)' object has no attribute 'get'/.test(message),
      'get_psets(e).get("<set>", {}).get("<property>") is already the VALUE (a number or text), not a dict: ' +
      "do not call .get() on it again."],
    [/has no attribute '(get_psets|material_names|storey_names|openings|fillings|elements_in|duplicate_guids)'/.test(message),
      "get_psets and the helpers are functions, not methods of an element: write get_psets(e), not e.get_psets()."],
    [/__import__ not found/.test(message),
      "do not import anything: Counter, the helpers (material_names, elements_in, ...) and model already exist."],
    [/'str' object has no attribute/.test(message),
      "a value you used is text, not an element. Maybe you looped over ONE element: rel.RelatingStructure is a " +
      "single element, not a list. material_names() and storey_names() give names (text), not elements."],
    [/'list' object has no attribute/.test(message),
      "you used a list as if it were one element. model.by_type(), openings(), fillings() and elements_in() " +
      "return LISTS: " +
      "loop over them, e.g. [f.Name for f in fillings(wall)]."],
    [/name 'result' is not defined/.test(message),
      'do not read "result" before you assign it; build the value in another variable first.'],
    [/name '\w+' is not defined/.test(message),
      "that name does not exist here. Use only model, get_psets, duplicate_guids, material_names, openings, " +
      "fillings, storey_names, elements_in, Counter, your own variables and: " +
      "len, range, enumerate, zip, sum, min, max, round, abs, list, dict, set, tuple, str, int, float, bool, " +
      "sorted, next, any, all, isinstance, hasattr, iter, reversed, map, filter."],
    [/unsupported operand type\(s\).*NoneType/.test(message),
      "some values are None (missing quantities or properties): remove them first, " +
      "values = [v for v in values if v is not None]."],
  ];
  const hit = hints.find(([matches]) => matches);
  return hit ? hit[1] : "";
}

// ---------- requests to DO something with the file ----------
// The tool only reads the model. "convert it to IFC2x3 and save it", "email me a PDF",
// "translate the property names" are refused here, by keyword, not by the LLM: when the
// splitter decided this, the 7B also refused real questions ("send me the stair guid",
// "tell me everything about element X").
const ACTION_WORDS = /\b(convert|save|export|e-?mail|pdf|translate|modify|delete|rename)\b/i;

export function isActionRequest(question) {
  return ACTION_WORDS.test(question);
}

// ---------- attributes the question names ----------
// "What is the description of the wall?" -> wall.Description. Small models look for it in get_psets.
const ATTRIBUTES = [
  [/\bdescriptions?\b/i, "Description"],
  [/\bobject\s?types?\b/i, "ObjectType"],
  [/\bpredefined\s?types?\b/i, "PredefinedType"],
  [/\belevations?\b/i, "Elevation"],
  [/\btags?\b/i, "Tag"],
];

// attribute names the question mentions but the code never reads as ".Attribute"
export function ignoredAttributes(question, code) {
  return ATTRIBUTES
    .filter(([words, name]) => words.test(question) && !code.includes(`.${name}`))
    .map(([, name]) => name);
}