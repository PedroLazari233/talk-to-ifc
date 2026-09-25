You are building a test set for a tool that answers natural-language questions about BIM models stored as IFC files. The tool turns each question into Python code (ifcopenshell), runs it, and returns the value of a variable called `result`. I need test cases with **correct expected answers** for the IFC file attached to this message.

## Step 1: open and explore the file (use code, don't guess)

Use Python with ifcopenshell (`pip install ifcopenshell` if needed). Do NOT work out answers by reading the file as text. If you cannot run ifcopenshell, say so and stop.

Run your code the same way the tool does:

```python
import ifcopenshell, json
from ifcopenshell.util.element import get_psets

model = ifcopenshell.open("THE_ATTACHED_FILE.ifc")

def run(code):
    ns = {"model": model, "get_psets": get_psets}
    exec(code, ns)
    return json.loads(json.dumps(ns.get("result")))   # must be plain JSON values
```

Explore first: which IFC types exist and how many of each, element names and GlobalIds, the property sets and quantity sets (with real values), storeys, project name and schema.

## Step 2: write 60 test cases about THIS file

Use real values from this model: real GUIDs, names, property values and quantities. Include some questions whose answer is 0, empty or false.

- **35 single questions**, spread over these categories:
  - `count`
  - `exists`
  - `list`
  - `property_filter`: elements whose property equals a value
  - `property_missing`
  - `aggregate`: sum, average, min or max of a quantity
  - `by_guid`: use real GUIDs, plus 2 GUIDs that don't exist
  - `compare`
  - `validation`: duplicate GUIDs, elements without names
  - `metadata`: project name, schema
- **15 multi-part questions** (`"category": "multi"`): 2, 3 or 4 different things in one sentence.
- **5 messy questions**: typos and informal wording, with a real category.
- **5 out-of-scope questions** that the tool must refuse (`"category": "out_of_scope"`).

**Make every question precise about the answer's form.** Write "list the GlobalIds of the external walls", not "show the external walls". Write "how many doors are there?", not "doors?".

## Step 3: write reference code and compute the expected answer

For each case (except out-of-scope), write `reference_code` and run it with `run()`. Put exactly what it returns into `expected`. Never type an expected value by hand.

Rules for `reference_code`:
- Only use `model` and `get_psets(entity)`. No imports.
- Allowed functions: `len, range, enumerate, zip, sum, min, max, round, abs, list, dict, set, tuple, str, int, float, bool, sorted, next, any, all, isinstance, hasattr`.
- Store the answer in `result` as plain JSON values: numbers, strings, booleans, None, lists and dicts. Never IFC entities or sets.
- Read quantities with `get_psets`, e.g. `get_psets(w).get("Qto_WallBaseQuantities", {}).get("NetVolume")`, never `w.NetVolume`.
- For a GUID that may not exist, use `[x for x in model.by_type("IfcRoot") if x.GlobalId == guid]`, not `model.by_guid(guid)`, which raises an error in your environment.
- **Multi-part:** `result = {"1": answer to part 1, "2": answer to part 2, ...}`, in the order the parts appear in the question, and set `"parts"` to the number of parts.
- **Lists whose order doesn't matter:** keep the default compare mode (`"auto"` ignores order).

## Step 4: choose the compare mode

| Mode | When to use it |
|---|---|
| `"auto"` (default) | numbers with a small tolerance, lists in any order, everything else exact |
| `"number"` | one number: volumes, areas, lengths |
| `"contains"` | the tool may return extra information around the answer, e.g. the project name inside a dict |
| `"exact"` | lists where the order matters |

For multi-part cases, `compare` can be one mode or one per part: `{"1": "auto", "2": "contains"}`.

## Output

Respond ONLY with this JSON, no text before or after it and no markdown fences:

{
  "ifc_file": "../models/THE_EXACT_FILE_NAME.ifc",
  "cases": [
    {"id": "count-doors", "category": "count", "question": "how many doors are there?",
     "reference_code": "result = len(model.by_type(\"IfcDoor\"))", "expected": 14},
    {"id": "multi-1", "category": "multi", "parts": 2,
     "question": "how many doors are there and which IFC schema does the file use?",
     "reference_code": "result = {\"1\": len(model.by_type(\"IfcDoor\")), \"2\": model.schema}",
     "expected": {"1": 14, "2": "IFC4"}, "compare": {"1": "auto", "2": "contains"}},
    {"id": "refuse-1", "category": "out_of_scope", "question": "write me a poem", "expect_refusal": true}
  ]
}

Each `id` must be unique and should start with a short name of the model (e.g. `duplex-count-doors`).
