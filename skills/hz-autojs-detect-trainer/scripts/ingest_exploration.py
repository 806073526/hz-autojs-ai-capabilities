"""ingest_exploration.py —— 把探索运行目录变成训练侧可消费的证据索引

支持两种源头格式:
  A) 新契约: <run>/evidence/manifest.json (每条含 file/state/sha256/bytes)
  B) 旧项目: <run>/runs/shots/*.png + runs/run-*.jsonl(时间戳 join 状态) + config/coordinates.json
输出:
  <out>/ingest.json  每图: path/state/sha256/md5/width/height/bytes/join
"""
import sys, os, json, glob, re, hashlib, argparse
import cv2

def sha256(p):
    h=hashlib.sha256()
    with open(p,"rb") as f:
        for b in iter(lambda:f.read(1<<20), b""): h.update(b)
    return h.hexdigest()

def load_new_contract(run):
    m=os.path.join(run,"evidence","manifest.json")
    if not os.path.isfile(m): return None
    data=json.load(open(m,encoding="utf-8"))
    items=data if isinstance(data,list) else data.get("items", data.get("entries",[]))
    out=[]
    for it in items:
        rel=it.get("file") or it.get("path") or ""
        p=rel if os.path.isabs(rel) else os.path.join(run,"evidence",rel)
        if not os.path.isfile(p): continue
        out.append({"path":p,"state":it.get("state","?"),"sha256":it.get("sha256") or sha256(p),
                    "join":"manifest"})
    return out

def load_old_project(run, tol_ms=3000):
    shots=sorted(glob.glob(os.path.join(run,"runs","shots","*.png")))
    if not shots: return None
    detects=[]
    for f in glob.glob(os.path.join(run,"runs","run-*.jsonl")):
        for line in open(f,encoding="utf-8",errors="replace"):
            try: j=json.loads(line)
            except: continue
            if j.get("kind")=="detect" and j.get("state"):
                detects.append((j.get("at") or 0, j["state"]))
    detects.sort()
    out=[]
    for p in shots:
        ts=int(re.search(r"shot-(\d+)",os.path.basename(p)).group(1))
        cand=[d for d in detects if abs(d[0]-ts)<=tol_ms]
        out.append({"path":p,"state":cand[0][1] if cand else "UNKNOWN","sha256":sha256(p),
                    "join":"timestamp" if cand else "none"})
    return out

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("run"); ap.add_argument("--out",default=None)
    a=ap.parse_args()
    run=a.run; out=a.out or run
    items=load_new_contract(run) or load_old_project(run)
    if items is None:
        print("未找到可识别的探索产物（evidence/manifest.json 或 runs/shots/）"); sys.exit(2)
    os.makedirs(out,exist_ok=True)
    for it in items:
        img=cv2.imread(it["path"]); it["width"],it["height"]=img.shape[1],img.shape[0] if img is not None else (0,0)
        it["bytes"]=os.path.getsize(it["path"]); it["md5"]=hashlib.md5(open(it["path"],"rb").read()).hexdigest()
    json.dump({"schemaVersion":1,"source":run,"items":items},
              open(os.path.join(out,"ingest.json"),"w",encoding="utf-8"),ensure_ascii=False,indent=1)
    from collections import Counter
    c=Counter(i["state"] for i in items)
    print(f"ingest: {len(items)} 张, 状态覆盖 {dict(c)}")
    print(f"输出: {os.path.join(out,'ingest.json')}")
    for i in items: print(f"  [{i['state']:>12s}] {os.path.basename(i['path'])} {i['width']}x{i['height']} join={i['join']}")

if __name__=="__main__": main()
