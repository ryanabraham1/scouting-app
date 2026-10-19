"""Parallel coordinate search on TRAIN years only (log loss). Test years (2023-26) untouched."""
import sys, json, importlib
from multiprocessing import Pool
from run import backtest
from common import metrics

TRAIN = [2016, 2017, 2018, 2019, 2020, 2022]
modname, clsname = sys.argv[1], sys.argv[2]
space = json.loads(sys.argv[3]); start = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
iters = int(sys.argv[5]) if len(sys.argv) > 5 else 3

def loss(kw):
    Cls = getattr(importlib.import_module(modname), clsname)
    r = backtest(Cls(**kw), years=TRAIN)
    ps, ys = [], []
    for y in TRAIN[1:]: ps += r[y][0]; ys += r[y][1]
    return metrics(ps, ys)['logloss']

if __name__ == '__main__':
    Cls = getattr(importlib.import_module(modname), clsname)
    base = Cls().p
    cur = dict(start)
    with Pool(10) as pool:
        best = pool.apply(loss, (cur,)); print('start', best, flush=True)
        for it in range(iters):
            while True:
                cands = []
                for k, (lo, hi) in space.items():
                    v0 = cur.get(k, base[k]); step = (hi - lo) / 4 / (2 ** it)
                    for v in (v0 - step, v0 + step):
                        if lo <= v <= hi: cands.append(dict(cur, **{k: v}))
                ls = pool.map(loss, cands)
                i = min(range(len(ls)), key=ls.__getitem__)
                if ls[i] < best - 1e-6:
                    best, cur = ls[i], cands[i]; print(f'  -> {best:.5f} {json.dumps(cur)}', flush=True)
                else:
                    break
            print('iter', it, best, json.dumps(cur), flush=True)
    print('FINAL', json.dumps(cur), best)
