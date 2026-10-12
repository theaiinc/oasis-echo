import json, sys
r = json.load(open(sys.argv[1])); T = [str(t) for t in r["thresholds"]]
print(r["model"], "patience", r["patience"], "thresholds", T)
for c, g in r["recall"].items():
    for k, v in g.items(): print(f"recall {c:5s} {k:10s} n={v['n']:4d}", [v[t] for t in T])
for k, v in r["fa_per_hour"].items(): print(f"FA/h {k:28s} {r['hours'].get(k)}h", [v[t] for t in T])
if len(sys.argv) > 2:
    for k, v in r["lookalike"].items():
        if any(v[t] > 0 for t in T): print(f"look {k:28s} n={v['n']}", [v[t] for t in T])
