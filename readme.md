# talk-to-ifc

Ask questions about an IFC/BIM model in plain language ("how many external doors are on Level 1?")
and get the answer computed from the file. An LLM writes a few lines of Python (ifcopenshell), a
sandbox runs them against the model, and a set of checks catches wrong answers before you see them.

Works with any LLM: a local one (Ollama), your own server (vLLM, RunPod) or a hosted API.

## How a question is answered

```
question
  │
  ▼  1. split        pipeline.js        -> LLM: "how many walls and doors?" -> 2 sub-questions
  ▼  2. search       server/server.py   -> /search: the closest examples from examples_index.json
  ▼  3. write code   pipeline.js        -> LLM gets rules + what the model contains + examples, writes Python
  ▼  4. run          server/server.py   -> /execute: runs the code in a sandbox, returns `result`
  ▼  5. check        checks.js          -> wrong kind of answer? ignored property? made-up GUID? ...
  │                                        if so: back to 3 with the exact problem (up to LLM_RETRIES times)
  ▼
answer (+ a warning if it still looks doubtful)
```

Two processes work together:
- **Python (`server/`)** holds the IFC file and does everything that needs ifcopenshell or embeddings.
- **Node (project root)** talks to the LLM and runs the checks. It calls the Python server over HTTP.

## The files

### Python side (`server/`)

| File | What it does |
|---|---|
| `server.py` | Flask server on port 5001. `/load` opens an IFC file, `/summary` lists the types and property sets it contains (goes into the prompt), `/search` finds the closest examples, `/execute` runs generated code in a sandbox. The sandbox only has `model`, `get_psets` and the helpers (`duplicate_guids`, `material_names`, `openings`, `fillings`, `storey_names`, `elements_in`, `Counter`) plus a short list of safe builtins. |
| `build_index.py` | The example questions and the code that answers each one. Running it turns every example question into a vector and writes `examples_index.json` next to it. Run it again after editing an example. |
| `search_text.py` | Normalizes text before it is turned into a vector, so the search matches WHAT is asked, not WHICH type: "doors with no FireRating" becomes "elements with no property". Used by both `build_index.py` and `server.py`. |
| `check_retrieval.py` | Debug tool: shows which example each question finds and its score, without the LLM. Use it after editing examples. |
| `requirements.txt` | The Python libraries: `pip install -r server/requirements.txt`. |

### Node side (project root)

| File | What it does |
|---|---|
| `pipeline.js` | The core: settings from `.env`, the LLM call (OpenAI-compatible or Anthropic format), splitting, example search, the prompt, retries, the per-part fallback for multi-part questions, and `query_log.jsonl`. `ask(question)` is the one function everything else calls. |
| `checks.js` | Rules that spot wrong answers without asking an LLM: code that never stores `result`, answers typed by hand, invented GUIDs, the wrong kind of answer (a text for "how many"), a property, property set or IFC type the question names but the code ignores, a type counted twice. Also turns Python errors into hints the model can act on. |
| `caller.js` | Interactive command line: type a question, get the answer. |

### Tests (`tests/`)

| File | What it does |
|---|---|
| `cases/open_models.json` | 158 test questions over 8 open IFC models, each with the code that gives the right answer and the expected answer. |
| `download_models.js` | Downloads the 8 models into `tests/models/` and checks each file's fingerprint (SHA-256). |
| `check_cases.js` | Checks the test cases themselves (no LLM): every reference code runs and matches its expected answer. |
| `ifc_answers.test.js` | The real test: every question through the whole pipeline, compared with the expected answer. Writes `tests/reports/report_<time>_<model>.jsonl`. |
| `cases.js`, `compare.js` | Helpers for the two scripts above: loading case files, comparing answers (numbers with tolerance, lists in any order...). |
| `test_generator_prompt.md` | A prompt to have another AI write new test cases for a new IFC file. |

### Settings and project files

| File | What it does |
|---|---|
| `.env.example` | Template for your settings. Copy it to `.env`. |
| `.env` | Your settings and API key. **Never committed** (it is in `.gitignore`). |
| `package.json` | Node dependencies, and short commands for everything (`npm run ...`, see below). |

### Generated (not in git, safe to delete, made again when needed)

`server/examples_index.json` (by `build_index.py`), `query_log.jsonl` (every question asked, for
debugging), `tests/reports/`, `tests/models/*.ifc` (by `download_models.js`), `__pycache__/`,
`node_modules/`.

## Setup

```
pip install -r server/requirements.txt
npm install
copy .env.example .env          # then edit .env: which LLM to use
npm run download-models         # the test models (about 70 MB)
npm run build-index             # builds server/examples_index.json
```

## Run

```
npm run server                  # terminal 1: the Python server, keep it running
npm run ask                     # terminal 2: ask questions
npm test                        # or: run the 158 test questions
npm run check-cases             # check the test cases themselves (needs the server, no LLM)
npm run check-retrieval         # which example each test question finds (no server, no LLM)
```

Every `npm run` command runs from the project root, so the paths in `.env` are relative to it.
The Python commands call `python`; if your system names it `python3` (Linux, Mac), run the
commands from `package.json` by hand with `python3`.

Run a single model file: `$env:TEST_IFC="Duplex.ifc"; npm test; Remove-Item Env:TEST_IFC` (PowerShell).

## Settings (`.env`)

| Name | Meaning |
|---|---|
| `LLM_FORMAT` | `openai` (Ollama, vLLM, OpenAI, DeepSeek...) or `anthropic` |
| `LLM_URL` | the chat endpoint, e.g. `http://localhost:11434/v1/chat/completions` for Ollama |
| `LLM_MODEL` | the model name, e.g. `qwen2.5:7b` |
| `LLM_API_KEY` | empty for local models |
| `LLM_RETRIES` | retries after a wrong answer (default 2) |
| `LLM_TIMEOUT_SECONDS` | how long to wait for one LLM reply (default 300) |
| `IFC_PATH` | the IFC file `npm run ask` opens, relative to the project root |

A PowerShell variable (`$env:LLM_MODEL=...`) wins over `.env`: handy to try another model for one run.