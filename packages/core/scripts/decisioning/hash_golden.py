"""golden_qev.py's output -> test/decisioning/qev-golden.json: a sha256 per case, layout and readout.
usage: python3 -I hash_golden.py <golden_qev out.json> <onejev commit>"""
import hashlib
import json
import os
import sys

g = json.load(open(sys.argv[1]))
out = {
    "_note": "qev's own rendering (OmniJev/OneJev qev/prompt.py + the OneJev1.6-0.8B chat template) of made-up prompts, "
    "as a sha256 of every branch's text joined with \\u0000. OneJev at " + sys.argv[2] + ". made by packages/core/scripts/decisioning/golden_qev.py",
    "prompt_version": g["prompt_version"],
    "tokenizer": g["tokenizer"],
    "letters": g["letters"],
    "cases": [],
}
for c in g["cases"]:
    row = {"text": c["text"]}
    if c.get("prev") is not None:
        row["prev"] = c["prev"]
    row["sha256"] = {k: hashlib.sha256("\u0000".join(v).encode()).hexdigest() for k, v in c["renders"].items()}
    out["cases"].append(row)
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../test/decisioning/qev-golden.json")
json.dump(out, open(p, "w"), indent=1, ensure_ascii=False)
open(p, "a").write("\n")
