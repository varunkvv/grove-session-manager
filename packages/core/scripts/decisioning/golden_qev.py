"""qev's own rendering of made-up cases, for core's golden test (test/decisioning/qev-golden.json).

run from this folder with OneJev's source checked out somewhere (qev is not on PyPI):
  uv run --no-project --with transformers --with jinja2 --with "qev @ file://<OneJev checkout>" \
    python -I golden_qev.py ../../src/decisioning/gavel.rubric.json golden_cases.json <out.json>
then hash it into the golden with hash_golden.py. the cases are made up: never put a real prompt here.
writes texts per branch (score, shift 5, noul) for both layouts, and token ids for the score readout
(what check-tokens.ts compares node-llama-cpp's tokenizer against)."""
import json, sys
from transformers import AutoTokenizer
from qev.engine import DecisionEngine
from qev.prompt import PROMPT_VERSION, render_question, DEFAULT_STYLE
from qev.schema import NoulQuestion, ScoreQuestion

TOK = "OmniJev/OneJev1.6-0.8B"
REV = "0acd65660ac22ca42f40b8b6a6da3a039590b412"

class Fake:
    def __init__(self, tok):
        self.tokenizer = tok
        self.template_kwargs = {"enable_thinking": False}
        self.style = DEFAULT_STYLE
    _render_prompt = DecisionEngine._render_prompt
    _encode = DecisionEngine._encode

r = json.load(open(sys.argv[1]))
cases = json.load(open(sys.argv[2]))
tok = AutoTokenizer.from_pretrained(TOK, revision=REV)
eng = Fake(tok)
context = r["context"] + " " + r["judge_hint"]

def state_of(layout, c):
    s = {}
    if layout == "context-in-state":
        s["context"] = context
    if c.get("prev"):
        s["previous_message"] = c["prev"]
    s["message"] = c["text"]
    return s

def questions_of(layout):
    out = []
    for q in r["questions"]:
        instr = q["instructions"] if layout == "context-in-state" else context + "\n\n" + q["instructions"]
        out.append({"id": q["id"], "instructions": instr, "criteria": q["criteria"]})
    return out

def suffixes(layout, readout):
    out = []
    for q in questions_of(layout):
        k = len(q["criteria"])
        sq = ScoreQuestion(type="score", instructions=q["instructions"], criteria=q["criteria"])
        if readout == "score":
            out.append(render_question(q["id"], sq))
        elif readout == "shift":
            for s in range(min(5, k)):
                order = [(i + s) % k for i in range(k)]
                out.append(render_question(q["id"], sq, order=order if s else None))
        else:
            for lv in range(k):
                instr = q["instructions"].strip() + "\n\nDoes this describe the message? " + str(q["criteria"][lv]).strip()
                out.append(render_question(q["id"], NoulQuestion(type="noul", instructions=instr)))
    return out

res = {"prompt_version": PROMPT_VERSION, "tokenizer": f"{TOK}@{REV}", "letters": [tok.encode(l, add_special_tokens=False) for l in "ABCDE"], "cases": []}
for c in cases:
    row = {"text": c["text"], "prev": c.get("prev"), "renders": {}}
    for layout in ("context-in-state", "message-only"):
        for readout in ("score", "shift", "noul"):
            rq = suffixes(layout, readout)
            state = state_of(layout, c)
            row["renders"][f"{layout}/{readout}"] = [eng._render_prompt(state, x.suffix) for x in rq]
            if layout == "context-in-state" and readout == "score":
                prefix, sfx = DecisionEngine._prefix_and_suffix_ids(eng, state, rq)
                row["tokens"] = {"prefix": prefix, "suffixes": sfx}
    res["cases"].append(row)
json.dump(res, open(sys.argv[3], "w"), ensure_ascii=False)
print("cases", len(res["cases"]))
