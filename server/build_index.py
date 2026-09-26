import json
from pathlib import Path
from sentence_transformers import SentenceTransformer

from search_text import normalize_for_search  # the same text normalization server.py uses

embedding_model = SentenceTransformer("all-MiniLM-L6-v2")

# The example code may only use the names that server.py provides:
#   model      -> the loaded IFC file (model.by_type, model.by_guid)
#   get_psets  -> get_psets(entity) returns its property sets and quantity sets
examples = [
    {
        "descriptions": [
            "how many elements of a type are there?",
            "what is the count of a specific IFC type?",
            "how many walls are in the model?",
            "give me the number of elements of a type",
            "count all elements of a type",
            # infra/MEP nouns are not in the normalizer's word list (only building elements are), so a
            # question using them scores low against the generic wording above unless one of these
            # matches it almost verbatim: bridges, pipe segments, ducts, roads, pavement courses...
            "how many bridges are there?",
            "how many pipe segments are there?",
            "how many ducts are there?",
            "how many pavement courses are there?",
        ],
        "code": 'result = len(model.by_type("IfcDoor"))'
    },
    {
        "descriptions": [
            "which elements have property X set to Y?",
            "which elements have a property set to a specific value?",
            "list the elements whose property equals a value",
            "show the elements where a property is true",
            "which elements are external?",
            "list the load-bearing elements",
            "which elements have a property equal to a number?",
        ],
        "code": '''elements = model.by_type("IfcWall")
matching = [e for e in elements if get_psets(e).get("Pset_WallCommon", {}).get("IsExternal") == True]
result = [e.Name for e in matching]'''
    },
    {
        "descriptions": [
            "does any element have a property set to a specific value?",
            "is there any element of a type with property X equal to Y?",
        ],
        "code": 'result = any(get_psets(e).get("Pset_DoorCommon", {}).get("IsExternal") == True for e in model.by_type("IfcDoor"))'
    },
    {
        "descriptions": [
            "are there any duplicated GUIDs?",
            "do two elements have the same GlobalId?",
            "is there a duplicate GlobalId in the file?",
            "check whether any GlobalId is duplicated",
        ],
        "code": 'result = len(duplicate_guids()) > 0  # duplicate_guids(): GlobalIds used by more than one entity'
    },
    {
        "descriptions": [
            "which GUIDs are duplicated?",
            "list the duplicate GlobalIds and how many there are",
        ],
        "code": '''duplicated = duplicate_guids()  # GlobalIds used by more than one entity
result = {"count": len(duplicated), "guids": duplicated}'''
    },
    {
        "descriptions": [
            "does the building have a name?",
            "does the project have a name?",
            "is there a name for this element?",
            "check whether the building has a name",
        ],
        "code": '''buildings = model.by_type("IfcBuilding")  # the same for a project: model.by_type("IfcProject")
result = bool(buildings and buildings[0].Name)'''
    },
    {
        "descriptions": [
            "what is the total sum of a numeric property across elements?",
            "sum a numeric property of all elements of a type",
            "what is the total volume of all elements?",
        ],
        "code": '''walls = model.by_type("IfcWall")
values = [get_psets(w).get("Qto_WallBaseQuantities", {}).get("NetVolume") for w in walls]
values = [v for v in values if v is not None]
result = sum(values)'''
    },
    {
        "descriptions": [
            "what is the largest wall length?",
            "what is the maximum value of a property?",
            "what is the minimum height of the walls?",
        ],
        "code": '''walls = model.by_type("IfcWall")
values = [get_psets(w).get("Qto_WallBaseQuantities", {}).get("Length") for w in walls]
values = [v for v in values if v is not None]
result = max(values, default=None)  # smallest: min(values, default=None)'''
    },
    {
        "descriptions": [
            "what is the average value of a property?",
            "what is the mean volume of the elements?",
            "what is the average length of the walls?",
        ],
        "code": '''slabs = model.by_type("IfcSlab")
values = [get_psets(s).get("Qto_SlabBaseQuantities", {}).get("NetVolume") for s in slabs]
values = [v for v in values if v is not None]  # elements without the value do not count
result = sum(values) / len(values) if values else None'''
    },
    {
        "descriptions": [
            "list the names of elements of a type",
            "what are the names of the elements of a type?",
            "can you list me all elements?",
            "list all elements in the model",
        ],
        "code": '''elements = model.by_type("IfcElement")
result = [e.Name for e in elements if e.Name]'''
    },
    {
        "descriptions": [
            "which elements do NOT have a specific property?",
            "find elements missing a property",
            "elements without a given property set",
            "which elements have no value for a property?",
        ],
        "code": '''elements = model.by_type("IfcWall")
# no FireRating at all, or one with no value (None or ""): both count as missing
missing = [e for e in elements if get_psets(e).get("Pset_WallCommon", {}).get("FireRating") in (None, "")]
result = [e.Name for e in missing]'''
    },
    {
        "descriptions": [
            "compare the count of two different types",
            "which of two types has more elements?",
            "which is there more of, type A or type B?",
        ],
        "code": '''doors = len(model.by_type("IfcDoor"))
windows = len(model.by_type("IfcWindow"))
if doors > windows:
    more = "IfcDoor"
elif windows > doors:
    more = "IfcWindow"
else:
    more = "same amount"
result = {"IfcDoor": doors, "IfcWindow": windows, "more": more}'''
    },
    {
        "descriptions": [
            "are there more elements of type A than type B?",
            "are there fewer elements of one type than another?",
            "is the count of one type greater than the count of another?",
        ],
        "code": 'result = len(model.by_type("IfcDoor")) > len(model.by_type("IfcWindow"))'
    },
    {
        "descriptions": [
            "is there any window in the model?",
            "is there any element of a type?",
            "does the model contain a beam?",
            "check if there is a stair in the model",
            "are there any elements of a type?",
            "does an element of a given type exist in the file?",
            "are there any pipe segments?",
            "is there a duct in the model?",
            "does the model contain a bridge?",
            "is there any road in the file?",
        ],
        "code": 'result = len(model.by_type("IfcWindow")) > 0'
    },
    {
        "descriptions": [
            "how many elements of a specific type have a property equal to a value?",
            "count elements of a type filtered by property value",
            "how many elements have a property equal to a specific value?",
        ],
        "code": '''elements = model.by_type("IfcWall")  # by_type already includes subtypes (IfcWallStandardCase...) - never add them again
matching = [e for e in elements if get_psets(e).get("Pset_WallCommon", {}).get("FireRating") == "A60"]
result = len(matching)'''
    },
    {
        "descriptions": [
            "how many elements have a word in a text property?",
            "which elements have a property value that contains a given text?",
            "how many elements have a specific word in a property?",
            "count elements whose property text includes a substring",
            "which elements have a property that mentions a word?",
        ],
        "code": '''elements = model.by_type("IfcWall")
matching = [e for e in elements if "Exterior" in (get_psets(e).get("Pset_WallCommon", {}).get("Reference") or "")]
result = len(matching)'''
    },
    {
        "descriptions": [
            "give me the guid of any element",
            "give me the guid of one of the elements",
            "show me one element from the model, any type",
            "share a single GUID from the model",
            "give me one GlobalId, any element",
        ],
        "code": '''elements = model.by_type("IfcElement")
if len(elements) > 0:
    result = elements[0].GlobalId
else:
    result = None'''
    },
    {
        "descriptions": [
            "give me the guid of the stair",
            "what is the guid of the wall?",
            "what is the guid of a specific element?",
            "get the GlobalId of an element of a known type",
        ],
        "code": 'result = [e.GlobalId for e in model.by_type("IfcStair")]'
    },
    {
        "descriptions": [
            "list all guid of all elements",
            "give me the GlobalId of every element",
            "list the guids of the elements in the model",
        ],
        "code": 'result = [{"guid": e.GlobalId, "type": e.is_a(), "name": e.Name} for e in model.by_type("IfcElement")]'
    },
    {
        "descriptions": [
            "give me all properties of one element of a type",
            "show all property sets of one wall",
            "what are the properties of the first stair?",
            "list all properties of a single element of a type",
        ],
        "code": '''elements = model.by_type("IfcStair")
if len(elements) > 0:
    result = get_psets(elements[0])
else:
    result = None'''
    },
    {
        "descriptions": [
            "get an element by its GUID",
            "give me all properties of the element with guid X",
            "list all properties of the element with guid X",
            "send properties of the element with this global id",
            "find element by GlobalId and show its info",
            "properties of the stair with guid X",
            "tell me about element X",
            "what is the type and name of element X?",
            "identify the element with guid X",
        ],
        "code": '''guid = "3vB2YO$MX4xv5uCqZZG05x"  # use the GUID written in the question
target = model.by_guid(guid)  # None if the GUID is not in the model
if target:
    result = {
        "type": target.is_a(),
        "name": target.Name,
        "psets": get_psets(target)
    }
else:
    result = "No element with GUID " + guid + " in this model"'''
    },
    {
        "descriptions": [
            "what is the IFC type of element X?",
            "what is the name of the element with GlobalId X?",
            "which type is the element with this guid?",
        ],
        "code": '''guid = "3vB2YO$MX4xv5uCqZZG05x"  # use the GUID written in the question
target = model.by_guid(guid)  # None if the GUID is not in the model
result = target.is_a() if target else "No element with GUID " + guid + " in this model"  # its name: target.Name'''
    },
    {
        "descriptions": [
            "list all the types present in the model",
            "which IFC types exist in the model?",
            "what kinds of elements are in the model?",
            "give me a breakdown of the model by IFC type",
            "list all types of elements",
        ],
        "code": '''counts = {}
for entity in model.by_type("IfcProduct"):
    ifc_type = entity.is_a()
    counts[ifc_type] = counts.get(ifc_type, 0) + 1
result = counts'''
    },
    {
        "descriptions": [
            "what is the description of an element?",
            "what is the object type of the elements of a type?",
            "what is the predefined type or tag of an element?",
        ],
        "code": '''# attributes are read directly from the element (they are not in get_psets):
# e.Description, e.ObjectType, e.PredefinedType, e.Tag, and e.Elevation for storeys
result = [e.Description for e in model.by_type("IfcWall")]'''
    },
    {
        "descriptions": [
            "what is the description of THE chimney?",  # "the X": one specific element, not a list of every X
            "what is the object type of the footing?",
            "what is the predefined type of the terminal?",
        ],
        "code": '''elements = model.by_type("IfcChimney")  # use the type the question names
result = elements[0].Description if elements else None  # one value, not a list: only one element is asked for'''
    },
    {
        "descriptions": [
            "what is the name of the model?",
            "what is the name of the project?",
            "which model are we working with?",
        ],
        "code": '''projects = model.by_type("IfcProject")
result = projects[0].Name if projects else None'''
    },
    {
        "descriptions": [
            "what is the name of the building?",
            "what is the building called?",
            "does the building have a name?",
        ],
        "code": '''buildings = model.by_type("IfcBuilding")  # the site: IfcSite; the project: IfcProject
result = buildings[0].Name if buildings else None'''
    },
    {
        "descriptions": [
            "what is the name of the element with the largest value?",
            "which room is the largest? give its name",
            "list the 3 largest elements by a quantity",
            "which are the longest elements? top 5",
            "which element has the smallest value of a property?",
        ],
        "code": '''spaces = [s for s in model.by_type("IfcSpace")
          if get_psets(s).get("Qto_SpaceBaseQuantities", {}).get("NetFloorArea") is not None]
spaces = sorted(spaces, key=lambda s: get_psets(s)["Qto_SpaceBaseQuantities"]["NetFloorArea"], reverse=True)
result = [s.Name for s in spaces[:3]]  # only the largest: spaces[0].Name   smallest first: reverse=False'''
    },
    {
        "descriptions": [
            "how many elements have each value of an attribute?",
            "count the elements per value",
            "how many doors are there of each object type?",
        ],
        "code": '''result = dict(Counter(d.ObjectType for d in model.by_type("IfcDoor")))  # value -> how many times'''
    },
    {
        "descriptions": [
            "which values appear more than 3 times?",
            "which values occur at least N times?",
        ],
        "code": '''counts = Counter(d.ObjectType for d in model.by_type("IfcDoor"))  # value -> how many times
result = [value for value, n in counts.items() if n > 3]'''
    },
    {
        "descriptions": [
            "which value appears most often?",
            "what is the most common type of element?",
            "what is the most common material?",
        ],
        "code": '''counts = Counter(e.is_a() for e in model.by_type("IfcElement"))  # value -> how many times
result = counts.most_common(1)[0][0] if counts else None
# per material, count each element's names: Counter(n for e in elements for n in material_names(e))'''
    },
    {
        "descriptions": [
            "how many elements have no name?",
            "which elements are missing a name?",
            "list the elements without a name or with an empty name",
        ],
        "code": '''unnamed = [e for e in model.by_type("IfcElement") if not e.Name]  # "not" catches None and ""
result = len(unnamed)'''
    },
    {
        "descriptions": [
            "what IFC schema does the file use?",
            "which IFC version is the file in?",
            "which of two schema versions does the file use?",
            "is the file IFC2X3 or IFC4X3?",
        ],
        "code": 'result = model.schema'
    },
    {
        "descriptions": [
            "list the storeys of the building",
            "what levels or floors does the building have?",
            "what are the floors of the building called?",
        ],
        "code": 'result = [s.Name for s in model.by_type("IfcBuildingStorey")]'
    },
    # ---- relationships: in IFC these are separate objects, not properties (get_psets can't see them)
    {
        "descriptions": [
            "which storey is an element on?",
            "on which level are the elements of a type located?",
            "in which storey is element X?",
        ],
        "code": '''result = storey_names(model.by_type("IfcDoor"))  # one element works too: storey_names(door)'''
    },
    {
        "descriptions": [
            "how many elements of a type are on a given storey?",
            "which elements are on level X?",
            "count the elements contained in a storey",
        ],
        "code": '''contained = elements_in("Level 1")  # the storey's name, as written in the question
result = len([e for e in contained if e.is_a("IfcWindow")])  # per type: dict(Counter(e.is_a() for e in contained))'''
    },
    {
        "descriptions": [
            "how many external doors are on level 1?",
            "which elements of a type on a storey have a property value?",
            "list the load-bearing walls on a given floor",
        ],
        "code": '''doors = [e for e in elements_in("Level 1") if e.is_a("IfcDoor")]  # storey first, then the type
external = [d for d in doors if get_psets(d).get("Pset_DoorCommon", {}).get("IsExternal") is True]
result = len(external)'''
    },
    {
        "descriptions": [
            "which material is an element made of?",
            "what materials are assigned to the elements of a type?",
            "what is the name of the material of element X?",
        ],
        "code": '''# material_names() handles single materials and material sets (layers, profiles, constituents)
result = material_names(model.by_type("IfcSlab"))  # one element works too: material_names(slab)'''
    },
    {
        "descriptions": [
            "how many openings does a wall have?",
            "which walls have openings?",
        ],
        "code": '''walls = model.by_type("IfcWall")
result = len(openings(walls))  # walls that have openings: [w.Name for w in walls if openings(w)]'''
    },
    {
        "descriptions": [
            "which element fills an opening?",
            "what is inserted in the openings of a wall?",
            "which doors or windows fill the openings?",
        ],
        "code": '''walls = model.by_type("IfcWall")
result = [f.Name for f in fillings(walls)]  # the doors and windows placed in the walls' openings'''
    },
]

index = []
for ex in examples:
    for desc in ex["descriptions"]:
        # the vector is made from the NORMALIZED text ("which walls..." -> "which elements..."),
        # exactly like the questions in server.py; the original text is kept for the prompt
        vector = embedding_model.encode(normalize_for_search(desc)).tolist()
        index.append({
            "description": desc,
            "code": ex["code"],
            "vector": vector
        })

# written next to this file, where server.py reads it
INDEX_FILE = Path(__file__).parent / "examples_index.json"
with open(INDEX_FILE, "w") as f:
    json.dump(index, f)

print(f"Saved {len(index)} embeddings from {len(examples)} examples to {INDEX_FILE}")