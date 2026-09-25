import json
import traceback
from pathlib import Path
from collections import Counter

import ifcopenshell
import numpy as np
from flask import Flask, request, jsonify
import ifcopenshell.util.element
from ifcopenshell.util.element import get_psets
from sentence_transformers import SentenceTransformer, util
from werkzeug.exceptions import HTTPException

from search_text import normalize_for_search  # the same text normalization build_index.py uses

app = Flask(__name__)

# --- loaded ONCE, when the server starts (not on every question) ---
embedding_model = SentenceTransformer("all-MiniLM-L6-v2")

# next to this file, so the server finds it whatever folder it is started from
INDEX_FILE = Path(__file__).parent / "examples_index.json"
with open(INDEX_FILE, "r") as f:
    examples_index = json.load(f)


@app.errorhandler(Exception)
def unexpected_error(e):
    # Any crash inside a route answers JSON with the real Python error, instead of
    # Flask's HTML "500 Internal Server Error" page, so Node can show what went wrong.
    # The full traceback is still printed in this terminal.
    if isinstance(e, HTTPException):  # 404 unknown route, 405 wrong method...
        return jsonify({"success": False, "error": e.description, "error_type": type(e).__name__}), e.code
    traceback.print_exc()
    return jsonify({"success": False, "error": str(e), "error_type": type(e).__name__}), 500


# Forgiving versions of sum/max/min: small models often write sum(..., default=None)
# or max(a, b, default=None), which real Python rejects. The answer is still right
# if we just ignore the stray "default", so we do that instead of failing.
def forgiving_sum(iterable, start=0, **kwargs):
    # sum(values, None) crashed the 7B's average; a None start just means "from 0"
    return sum(iterable, 0 if start is None else start)


def forgiving_max(*args, **kwargs):
    if len(args) == 1 and isinstance(args[0], (int, float)):
        return args[0]  # max(5, default=1) -> 5 (real Python fails: "int is not iterable")
    if len(args) > 1:
        kwargs.pop("default", None)
    return max(*args, **kwargs)


def forgiving_min(*args, **kwargs):
    if len(args) == 1 and isinstance(args[0], (int, float)):
        return args[0]
    if len(args) > 1:
        kwargs.pop("default", None)
    return min(*args, **kwargs)


def to_plain(value):
    # Makes "result" JSON-friendly instead of failing on it:
    # an IFC entity becomes {"type", "guid", "name"}, a set/tuple becomes a list.
    # (the model often returns the elements themselves, e.g. result = [w for w in walls if ...])
    if isinstance(value, ifcopenshell.entity_instance):
        plain = {"type": value.is_a()}
        if hasattr(value, "GlobalId"):
            plain["guid"] = value.GlobalId
        if hasattr(value, "Name"):
            plain["name"] = value.Name
        return plain
    if isinstance(value, dict):
        return {str(k): to_plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        items = [to_plain(v) for v in value]
        if isinstance(value, (set, frozenset)):
            try:
                items = sorted(items)
            except TypeError:
                pass
        return items
    return value


safe_builtins = {
    "len": len, "range": range, "enumerate": enumerate, "zip": zip,
    "sum": forgiving_sum, "min": forgiving_min, "max": forgiving_max, "round": round, "abs": abs,
    "list": list, "dict": dict, "set": set, "tuple": tuple,
    "str": str, "int": int, "float": float, "bool": bool,
    "sorted": sorted, "next": next, "any": any, "all": all,
    "isinstance": isinstance, "hasattr": hasattr,
    "iter": iter, "reversed": reversed, "map": map, "filter": filter,
    # the answer goes in "result", so a print() in the generated code just does nothing
    "print": lambda *args, **kwargs: None,
}

# how many different examples /search returns when the request doesn't say
# (caller.js sends "top_n" itself: 1 per sub-question, 2 for a single question)
TOP_N = 2

ifc_model = None


def find_duplicate_guids(ifc_file):
    # GlobalIds used by more than one entity (a valid file has none), sorted.
    # Given to the generated code as duplicate_guids(): the 7B wrote nonsense for this
    # seen/duplicated loop twice, even with the right example in front of it.
    seen = set()
    duplicated = set()
    for entity in ifc_file.by_type("IfcRoot"):
        if entity.GlobalId in seen:
            duplicated.add(entity.GlobalId)
        seen.add(entity.GlobalId)
    return sorted(duplicated)


# ---- relationship helpers, given to the generated code by name ----
# The 7B kept getting these relationship walks wrong in different ways on each run
# (a wrong is_a() filter, looping over a single element, a made-up entity name),
# so they are done here once, correctly. Each helper accepts ONE element, a LIST
# of elements (e.g. model.by_type("IfcWall")), or None (by_guid found nothing).

def as_elements(value):
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return [v for v in value if v is not None]
    return [value]


def material_set_names(material):
    # A material is a single IfcMaterial or a set: layers (walls, slabs), profiles
    # (beams), constituents (windows), or a plain list. A set gives its own name,
    # or the names of its materials when it has none.
    if material is None:
        return []
    if material.is_a("IfcMaterialLayerSet"):
        own, parts = material.LayerSetName, [layer.Material for layer in material.MaterialLayers]
    elif material.is_a("IfcMaterialProfileSet"):
        own, parts = material.Name, [p.Material for p in material.MaterialProfiles]
    elif material.is_a("IfcMaterialConstituentSet"):
        own, parts = material.Name, [c.Material for c in material.MaterialConstituents or []]
    elif material.is_a("IfcMaterialList"):
        own, parts = None, list(material.Materials)
    else:  # IfcMaterial
        own, parts = getattr(material, "Name", None), []
    if own:
        return [own]
    return [p.Name for p in parts if p is not None and p.Name]


def material_names(elements):
    # material_names(e): names of the material assigned to e (or to its type).
    # material_names(list): the distinct names used by all of them, sorted.
    names = []
    for element in as_elements(elements):
        # should_skip_usage: a layer/profile "usage" is replaced by the set it points to
        material = ifcopenshell.util.element.get_material(element, should_skip_usage=True)
        for name in material_set_names(material):
            if name not in names:
                names.append(name)
    return sorted(names) if isinstance(elements, (list, tuple, set)) else names


def openings(elements):
    # the openings (IfcOpeningElement) cut into the element(s), e.g. a wall
    return [rel.RelatedOpeningElement
            for element in as_elements(elements)
            for rel in getattr(element, "HasOpenings", None) or []]


def fillings(elements):
    # the doors/windows placed in the openings of the element(s); an opening itself works too
    result = []
    for element in as_elements(elements):
        holes = [element] if element.is_a("IfcOpeningElement") else openings(element)
        for hole in holes:
            for rel in hole.HasFillings:
                result.append(rel.RelatedBuildingElement)
    return result


def storey_of(element):
    # Walks up until it reaches a storey: element -> its container (a storey, or a room)
    # or the element it is part of (a stair flight is part of a stair) -> ... -> the storey.
    # So a chair inside room A101 is on A101's storey.
    current = element
    for _ in range(10):  # a few levels at most; also stops a broken file from looping
        if current is None or current.is_a("IfcBuildingStorey"):
            return current
        current = (ifcopenshell.util.element.get_container(current)
                   or ifcopenshell.util.element.get_aggregate(current))
    return None


def storey_names(elements):
    # storey_names(e): [the name of the storey e is on]  (empty if it is on none)
    # storey_names(list): the distinct storey names of all of them, sorted
    names = []
    for element in as_elements(elements):
        storey = storey_of(element)
        if storey is not None and storey.Name and storey.Name not in names:
            names.append(storey.Name)
    return sorted(names) if isinstance(elements, (list, tuple, set)) else names


def find_places(ifc_file, value):
    # "Level 1" -> the storey(s) with that name (a room or other spatial element if no storey has it);
    # an element or a list is returned as it is
    if not isinstance(value, str):
        return as_elements(value)
    wanted = value.strip().lower()
    places = [p for p in ifc_file.by_type("IfcSpatialStructureElement")
              if wanted in ((p.Name or "").strip().lower(), (getattr(p, "LongName", None) or "").strip().lower())]
    storeys = [p for p in places if p.is_a("IfcBuildingStorey")]
    return storeys or places


def elements_in(ifc_file, places):
    # The elements CONTAINED in a storey (or room, building...): IFC's own meaning of
    # "contained", the IfcRelContainedInSpatialStructure link. A chair placed in a room
    # is contained in the room, not in the storey - use elements_in("A101") for it.
    return [element
            for place in find_places(ifc_file, places)
            for rel in getattr(place, "ContainsElements", None) or []
            for element in rel.RelatedElements]


class SafeModel:
    # What the generated code sees as "model": the real IFC file, except that
    # by_guid() returns None for an unknown GUID instead of raising an error.
    # Everything else (by_type, schema, ...) goes straight to the real file.
    def __init__(self, ifc_file):
        self._file = ifc_file

    def by_guid(self, guid):
        try:
            return self._file.by_guid(guid)
        except RuntimeError:
            return None

    def __getattr__(self, name):
        return getattr(self._file, name)


@app.route("/load", methods=["POST"])
def load_model():
    global ifc_model
    ifc_path = request.json.get("ifc_path")
    try:
        ifc_model = ifcopenshell.open(ifc_path)
    except Exception as e:
        return jsonify({"success": False, "error": str(e), "error_type": type(e).__name__})
    return jsonify({"success": True})


def product_types(schema_name):
    # Every concrete IfcProduct type of the schema, with the types above it:
    # {"IfcPipeSegment": ["IfcProduct", "IfcElement", ..., "IfcFlowSegment"], ...}
    # Not for the prompt: checks.js uses it to spot types the question names
    # ("pipe segments" -> IfcPipeSegment) that the code then ignores.
    schema = ifcopenshell.ifcopenshell_wrapper.schema_by_name(schema_name)
    found = {}

    def walk(declaration, ancestors):
        for sub in declaration.subtypes():
            if not sub.is_abstract():
                found[sub.name()] = ancestors
            walk(sub, ancestors + [sub.name()])

    walk(schema.declaration_by_name("IfcProduct"), ["IfcProduct"])
    return found


@app.route("/summary", methods=["GET"])
def summary():
    # What is actually IN the loaded file: types, counts, and the property/quantity
    # set names found on them. caller/batch put this in the prompt so the LLM stops
    # guessing names like "Pset_WallThermalProperties" that don't exist.
    if ifc_model is None:
        return jsonify({"success": False, "error": "No IFC model loaded. Call /load first.", "error_type": "NoModelLoaded"})

    types = {}
    for entity in ifc_model.by_type("IfcProduct"):
        info = types.setdefault(entity.is_a(), {"count": 0, "sets": {}, "example_name": None})
        info["count"] += 1
        if info["example_name"] is None and entity.Name:
            info["example_name"] = entity.Name[:60]  # one real name per type, e.g. "Canopy:Canopy_1500:3456"
        if info["count"] <= 20:  # reading a sample of each type is enough (and fast on big files)
            for set_name, props in get_psets(entity).items():
                names = info["sets"].setdefault(set_name, set())
                names.update(p for p in props if p != "id")

    return jsonify({
        "success": True,
        "schema": ifc_model.schema,
        "product_types": product_types(ifc_model.schema),
        "types": {
            t: {"count": i["count"], "example_name": i["example_name"],
                "sets": {s: sorted(p) for s, p in i["sets"].items()}}
            for t, i in sorted(types.items())
        }
    })


@app.route("/search", methods=["POST"])
def search():
    question = request.json.get("question")
    top_n = int(request.json.get("top_n", TOP_N))
    question_vec = embedding_model.encode(normalize_for_search(question))

    scored = []
    for item in examples_index:
        example_vec = np.array(item["vector"], dtype=np.float32)
        score = util.cos_sim(question_vec, example_vec).item()
        # the description goes back too: the prompt shows each example as "question -> code"
        scored.append({"code": item["code"], "description": item["description"], "score": score})

    scored.sort(key=lambda x: x["score"], reverse=True)

    # each example has several descriptions -> keep only its best-scoring entry
    # (so the description returned is the one closest to the question)
    seen_codes = set()
    top_unique = []
    for item in scored:
        if item["code"] not in seen_codes:
            top_unique.append(item)
            seen_codes.add(item["code"])
        if len(top_unique) >= top_n:
            break

    return jsonify(top_unique)


@app.route("/execute", methods=["POST"])
def execute():
    if ifc_model is None:
        return jsonify({"success": False, "error": "No IFC model loaded. Call /load first.", "error_type": "NoModelLoaded"})

    code = request.json.get("code")

    try:
        compiled = compile(code, "<generated>", "exec")
    except (SyntaxError, ValueError, TypeError) as e:
        return jsonify({"success": False, "error": str(e), "error_type": type(e).__name__})

    # ONE dict, used as both globals and locals: this way generator expressions,
    # lambdas and functions inside the generated code can also see these names
    namespace = {
        "__builtins__": safe_builtins,
        "model": SafeModel(ifc_model),
        "get_psets": get_psets,
        "duplicate_guids": lambda: find_duplicate_guids(ifc_model),
        "material_names": material_names,
        "openings": openings,
        "fillings": fillings,
        "storey_names": storey_names,
        "elements_in": lambda places: elements_in(ifc_model, places),
        "Counter": Counter,  # collections.Counter, so "import" is never needed
    }

    try:
        exec(compiled, namespace)
        return jsonify({"success": True, "result": to_plain(namespace.get("result"))})
    except Exception as e:
        return jsonify({"success": False, "error": str(e), "error_type": type(e).__name__})


if __name__ == "__main__":
    app.run(port=5001)