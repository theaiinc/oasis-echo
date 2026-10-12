import json,sys
r=json.load(open(sys.argv[1]))
nat=[k for k in r['hours'] if k not in ('ALL','tts_neg_test')]
H=sum(r['hours'][k] for k in nat)
for k,v in r['recall'].items(): print('recall',k,v)
for k in r['fa_per_hour']: print('FA/h',k,r['hours'][k],r['fa_per_hour'][k])
ts=list(r['fa_per_hour']['ALL'])
print('FA/h natural (excl. confusable TTS stream)', round(H,1),'h', {t: round(sum(r['fa_per_hour'][k][t]*r['hours'][k] for k in nat)/H,3) for t in ts})
