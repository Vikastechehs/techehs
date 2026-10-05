import json,sys,csv,glob,os
pages={int(r['no']):r for r in csv.DictReader(open(os.path.join(os.path.dirname(__file__),'pages.csv')))}
paths={r['path'] for r in pages.values()}
ICONS=set("shield clipboard alert users chart mobile bell lock file check cog leaf hardhat eye calendar book play globe layers search flame truck zap award map message tool building factory clock".split())
nums=[int(a) for a in sys.argv[1:]] or sorted(pages)
bad=0
for n in nums:
    f=os.path.join(os.path.dirname(__file__),'..','data',f'{n:02d}.json')
    try: d=json.load(open(f))
    except Exception as e: print(n,'ERR',e); bad+=1; continue
    errs=[]
    for k in ['no','path','type','template','meta_title','meta_description','h1','definition']:
        if not d.get(k): errs.append('missing '+k)
    if d.get('path')!=pages[n]['path']: errs.append('path mismatch')
    for r in d.get('related',[]):
        if r not in paths: errs.append('bad related '+r)
    for s in d.get('sections',[]):
        for it in s.get('items',[]):
            if it.get('link') and it['link'] not in paths: errs.append('bad link '+it['link'])
            if it.get('icon') and it['icon'] not in ICONS: errs.append('bad icon '+it['icon'])
    for ft in d.get('features',[]):
        if ft.get('icon') not in ICONS: errs.append('bad icon %s'%ft.get('icon'))
    if errs: bad+=1; print(n,'; '.join(errs))
print('checked',len(nums),'bad',bad)
