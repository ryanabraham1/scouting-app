"""match13-style benchmark: 2023-2026 pooled, winner acc, early-event acc, calibration gap (ECE)."""
import json, sys
from collections import defaultdict
import numpy as np
from run import backtest
from common import metrics
from sb import StatboticsEPA
from kal2 import KalmanEPA2
from kal3 import FullCovEPA
from kal4 import TwoStreamEPA

TEST = [2023, 2024, 2025, 2026]

def ece(p, y, bins=10):
    p, y = np.asarray(p), np.asarray(y)
    conf = np.maximum(p, 1 - p); corr = ((p > 0.5) == (y == 1)).astype(float)
    tot = 0
    for i in range(bins):
        lo, hi = 0.5 + i * 0.05, 0.5 + (i + 1) * 0.05
        k = (conf >= lo) & (conf < hi if i < bins - 1 else conf <= hi)
        if k.sum(): tot += k.sum() * abs(conf[k].mean() - corr[k].mean())
    return 100 * tot / len(p)

TRAIN = [2017, 2018, 2019, 2020, 2022]

def fit_calibrator(res):
    """Symmetric PAV isotonic map on confidence, fit on TRAIN-year predictions only."""
    P = np.concatenate([np.array(res[y][0]) for y in TRAIN]); Y = np.concatenate([np.array(res[y][1]) for y in TRAIN])
    k = Y != 0.5; P, Y = P[k], Y[k]
    conf = np.maximum(P, 1 - P); corr = ((P > 0.5) == (Y == 1)).astype(float)
    o = np.argsort(conf); x, yv = conf[o], corr[o]
    # pool adjacent violators on blocks of 200 for stability
    B = 200; xs = [x[i:i+B].mean() for i in range(0, len(x), B)]; ys = [yv[i:i+B].mean() for i in range(0, len(x), B)]; ws = [len(x[i:i+B]) for i in range(0, len(x), B)]
    bx, by, bw = [], [], []
    for xi, yi, wi in zip(xs, ys, ws):
        bx.append([xi]); by.append(yi); bw.append(wi)
        while len(by) > 1 and by[-2] > by[-1]:
            y2, w2, x2 = by.pop(), bw.pop(), bx.pop()
            by[-1] = (by[-1] * bw[-1] + y2 * w2) / (bw[-1] + w2); bw[-1] += w2; bx[-1] += x2
    cx = np.array([np.mean(b) for b in bx]); cy = np.maximum(0.5, np.array(by))
    def f(p):
        p = np.asarray(p, float); c = np.maximum(p, 1 - p)
        cc = np.interp(c, cx, cy)
        return np.where(p >= 0.5, cc, 1 - cc)
    return f

def summarize(name, res, cal=False):
    if cal:
        f = fit_calibrator(res)
        res = {y: (list(f(v[0])), v[1], v[2]) for y, v in res.items()}
        name += ' +cal'
    P, Y, E = [], [], []
    for y in TEST:
        ps, ys, ms = res[y]
        seen = defaultdict(int)
        for p, o, m in zip(ps, ys, ms):
            teams = m['red'] + m['blue']
            early = any(seen[(m['event'], t)] < 2 for t in teams)
            for t in teams: seen[(m['event'], t)] += 1
            if o == 0.5: continue
            P.append(p); Y.append(o); E.append(early)
    P, Y, E = np.array(P), np.array(Y), np.array(E)
    a = metrics(P, Y); ae = metrics(P[E], Y[E])
    print(f"{name:22s} acc={a['acc']*100:.2f}%  early-acc={ae['acc']*100:.2f}%  brier={a['brier']:.4f}  logloss={a['logloss']:.4f}  calib-gap={ece(P,Y):.2f}pts  n={a['n']}")

if __name__ == '__main__':
    kw = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    which = sys.argv[2] if len(sys.argv) > 2 else 'all'
    if which in ('all', 'sb'): summarize('Statbotics (replica)', backtest(StatboticsEPA()))
    if which in ('all', 'k2'): summarize('Kalman v2', backtest(KalmanEPA2(**kw)))
    if which in ('all', 'k3'):
        r3 = backtest(FullCovEPA(**kw)); summarize('FullCov v3', r3); summarize('FullCov v3', r3, cal=True)
    
    if which == 'k4':
        r4 = backtest(TwoStreamEPA(**kw)); summarize('TwoStream v4', r4)
