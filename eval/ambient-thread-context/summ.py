import json,sys,collections
rows=[json.loads(l) for l in open(sys.argv[1] if len(sys.argv)>1 else '/tmp/eval/judge.jsonl')]
labels=sorted({r['label'] for r in rows},key=lambda x:x)
sc=sorted({r['scenario'] for r in rows})
print('scenario'.ljust(42),*[l[:12].ljust(12) for l in labels])
for s in sc:
  cells=[]
  for l in labels:
    rs=[r for r in rows if r['label']==l and r['scenario']==s]
    if not rs: cells.append('-'.ljust(12)); continue
    acts=sum(r['decision']=='act' for r in rs); ok=sum(r['correct'] for r in rs)
    extra=''
    if any(r.get('askedOk') is not None for r in rs): extra=' ab%d'%sum(bool(r.get('askedOk')) for r in rs)
    cells.append(f"{ok}/{len(rs)} act{acts}{extra}".ljust(12))
  print(s[:42].ljust(42),*cells)
for l in labels:
  rs=[r for r in rows if r['label']==l]
  for k in ['h2h','keep']:
    x=[r for r in rs if r['kind']==k]; print(l,k,'correct %d/%d'%(sum(r['correct'] for r in x),len(x)),end='  ')
  t=[r['promptTokens'] for r in rs]; lat=sorted(r['latencyMs'] or 0 for r in rs)
  print('tokens mean %.0f'%(sum(t)/len(t)),'lat p50 %d'%lat[len(lat)//2])
