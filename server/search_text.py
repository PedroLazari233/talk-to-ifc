# search_text.py - the text that is actually EMBEDDED for the example search.
#
# Used on BOTH sides, so they always match:
#   build_index.py -> on every example description
#   server.py      -> on every question in /search
#
# Why: the embedding model matches on the nouns it sees. With "walls" in a question, the
# example "how many walls are in the model?" won, even for "list the wall names" or
# "which walls are external?". But the example to pick depends on WHAT is asked (count,
# list, filter, missing, sum...), not on WHICH type: the LLM reads the type from the
# question itself. So before embedding, names that only say "which thing" become neutral:
#   GUIDs                 -> X          "properties of 2O2Fr$t4X7Zf8NOew3FNr2" -> "properties of X"
#   IFC schema names      -> schema     "IFC2x3 or IFC4"                       -> "schema or schema"
#   IFC type names        -> element(s) "IfcBeam or IfcColumn"                 -> "element or element"
#   physical element words-> element(s) "which walls are external"             -> "which elements are external"
#   property names        -> property   "doors with no FireRating"             -> "elements with no property"
# Storeys and the project are NOT replaced: they have their own examples
# (a storey is not an IfcElement, so "list the storeys" needs different code).
import re

# an IFC GlobalId is 22 characters from: 0-9 A-Z a-z _ $. Accept 20 to 24 (typos, and
# ChatGPT-made test ids are often 23 long), but only with a digit AND a letter:
# a 22-letter property name like "ThermalTransmittance" is not an id
GUID_PATTERN = re.compile(r"(?<![0-9A-Za-z_$])[0-9A-Za-z_$]{20,24}(?![0-9A-Za-z_$])")
# some IFC names are also 22 characters long (e.g. Qto_WallBaseQuantities) -> not GUIDs
IFC_NAME_PREFIXES = ("ifc", "pset_", "qto_")

SCHEMA_PATTERN = re.compile(r"\bifc\s?(2x3|2x2|4x3|4x1|4x2|4)\b", re.IGNORECASE)

IFC_TYPE_PATTERN = re.compile(r"\bifc[a-z]+\b", re.IGNORECASE)
KEEP_IFC_TYPES = {"ifcproject", "ifcbuildingstorey"}  # the ones with their own examples

# physical elements (singular -> "element", plural -> "elements")
ELEMENT_WORDS = {
    "wall": "element", "walls": "elements",
    "door": "element", "doors": "elements",
    "window": "element", "windows": "elements",
    "stair": "element", "stairs": "elements", "staircase": "element", "staircases": "elements",
    "slab": "element", "slabs": "elements",
    "beam": "element", "beams": "elements",
    "column": "element", "columns": "elements",
    "roof": "element", "roofs": "elements",
    "railing": "element", "railings": "elements",
    "ramp": "element", "ramps": "elements",
    "plate": "element", "plates": "elements",
    "member": "element", "members": "elements",
}
ELEMENT_WORD_PATTERN = re.compile(r"\b(" + "|".join(ELEMENT_WORDS) + r")\b", re.IGNORECASE)

# common property names (not quantities: "height", "volume"... say WHAT is computed, so they stay)
PROPERTY_NAMES = [
    "FireRating", "IsExternal", "LoadBearing", "ThermalTransmittance", "AcousticRating", "Combustible",
    "SurfaceSpreadOfFlame", "Compartmentation", "HandicapAccessible", "FireExit", "SelfClosing",
    "SmokeStop", "SecurityRating", "GlazingAreaFraction", "NumberOfRiser", "NumberOfRisers",
    "NumberOfTreads", "RiserHeight", "TreadLength",
]


def _property_pattern(name):
    # "FireRating" also matches "fire rating", "fire-rating", "fire_rating"
    words = re.findall(r"[A-Z][a-z]*", name)
    return r"\b" + r"[\s_-]?".join(words) + r"\b"


PROPERTY_PATTERN = re.compile("|".join(_property_pattern(n) for n in PROPERTY_NAMES), re.IGNORECASE)


def normalize_for_search(text):
    def guid(match):
        token = match.group(0)
        if token.lower().startswith(IFC_NAME_PREFIXES) or not re.search(r"[0-9]", token) or not re.search(r"[A-Za-z]", token):
            return token
        return "X"

    def ifc_type(match):
        token = match.group(0)
        if token.lower() in KEEP_IFC_TYPES:
            return token
        return "elements" if token.lower().endswith("s") else "element"  # IfcElements / IfcSlab

    text = GUID_PATTERN.sub(guid, text)
    text = SCHEMA_PATTERN.sub("schema", text)          # before IFC types: "IFC4" is not a type
    text = IFC_TYPE_PATTERN.sub(ifc_type, text)
    text = ELEMENT_WORD_PATTERN.sub(lambda m: ELEMENT_WORDS[m.group(0).lower()], text)
    text = PROPERTY_PATTERN.sub("property", text)
    text = re.sub(r"\bproperty(\s+property)+\b", "property", text)  # "a FireRating property"
    return text


if __name__ == "__main__":
    # quick look: python search_text.py "Find doors with no FireRating"
    import sys
    print(normalize_for_search(" ".join(sys.argv[1:])))