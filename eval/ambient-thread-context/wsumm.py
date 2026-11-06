import json,sys
rows=[json.loads(l) for l in open(sys.argv[1] if len(sys.argv)>1 else '/tmp/eval/worker.jsonl')]
for sc in sorted({r['scenario'] for r in rows}):
  for l in sorted({r['label'] for r in rows}):
    rs=[r for r in rows if r['scenario']==sc and r['label']==l]
    if not rs: continue
    print(f"{sc[:34]:34} {l:8} n={len(rs)} replied={sum(r['replied'] for r in rs)} leakedFacts={sum(r['leaked'] for r in rs)} mentionsNeighbour={sum(r.get('mentionsNeighbour',False) for r in rs)} onTarget={sum(r['onTarget'] for r in rs)} posts={sum(len(r['replies']) for r in rs)}", [r['leakMatch'] for r in rs if r['leaked']])
if '-v' in sys.argv:
  for r in rows:
    for t in r['replies']: print(r['scenario'][:20],r['label'],'>',t[:300].replace('\n',' | '))
