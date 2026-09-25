# check_retrieval.py - which example does each question find? No LLM, no IFC file needed.
#
# usage:  python server/check_retrieval.py tests/cases/open_models.json   (a test case file)
#         python server/check_retrieval.py my_questions.json               (or a JSON list of questions)
#
# Use it after editing the examples in build_index.py (and re-running it) to see, in a few
# seconds, which questions now find the right example and which ones score too low.
# It searches with the WHOLE question; the pipeline searches each sub-question after splitting,
# so for multi-part questions the scores in the pipeline can differ.
import json
import sys

from search_text import normalize_for_search
from server import app  # loads the embedding model and examples_index.json (the server does not start)

MIN_SCORE = 0.4  # same value as pipeline.js


def load_questions(path):
    text = open(path, "r", encoding="utf-8").read().strip()
    if text.startswith("{"):
        items = json.loads(text)["cases"]  # a test case file: {"cases": [{"id": ..., "question": ...}]}
    elif text.startswith("["):
        items = json.loads(text)
    else:
        items = [json.loads(l) for l in text.splitlines() if l.strip()]
    return [(i + 1, item) if isinstance(item, str) else (item.get("id", i + 1), item["question"])
            for i, item in enumerate(items)]


if len(sys.argv) < 2:
    print("usage: python server/check_retrieval.py tests/cases/open_models.json")
    sys.exit(1)

client = app.test_client()
low = []
for qid, question in load_questions(sys.argv[1]):
    found = client.post("/search", json={"question": question, "top_n": 1}).get_json()
    best = found[0]
    first_line = best["code"].splitlines()[0]
    mark = "LOW " if best["score"] < MIN_SCORE else "    "
    if best["score"] < MIN_SCORE:
        low.append(qid)
    print(f"{mark}{best['score']:.2f}  #{qid} {question}")
    print(f"            searched as: {normalize_for_search(question)}")
    print(f"            -> \"{best['description']}\"   {first_line}")

print(f"\n{len(low)} question(s) below {MIN_SCORE}: {low}")