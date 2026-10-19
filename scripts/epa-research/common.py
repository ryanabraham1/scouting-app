"""Shared data loading + evaluation for FRC match-outcome backtests."""
import gzip, json, math, os, datetime
from functools import lru_cache
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CL = {'qm': 0, 'ef': 1, 'qf': 2, 'sf': 3, 'f': 4}


@lru_cache(maxsize=None)
def load_year(y):
    fn = os.path.join(HERE, 'data', f'{y}.json.gz')
    if not os.path.exists(fn):
        return None
    with gzip.open(fn, 'rt') as f:
        d = json.load(f)
    ev = d['events']
    out = []
    for m in d['matches']:
        r, b = m['red'], m['blue']
        if len(r['t']) != 3 or len(b['t']) != 3:
            continue
        if r['sc'] is None or b['sc'] is None or r['sc'] < 0 or b['sc'] < 0:
            continue
        e = ev.get(m['e'], {})
        # Offseason/preseason events are excluded from evaluation (like most
        # published accuracy numbers) but still kept for nothing: drop them.
        if e.get('type') not in (0, 1, 2, 3, 4, 5):  # regional, district, dcmp, cmp div, cmp final, dcmp div
            continue
        t = m['t']
        if not t:
            try:
                t = datetime.datetime.strptime(e['start'], '%Y-%m-%d').timestamp() + 86400 * 2
            except Exception:
                t = 0
            t += CL[m['cl']] * 3600 + m['n'] * 60
        def nf(a):
            f = a.get('foul'); adj = a.get('adj')
            if f is None:
                return float(a['sc'])
            return float(a['sc'] - f - (adj or 0))
        w = m.get('w')
        rs, bs = r['sc'], b['sc']
        if w in ('red', 'blue'):
            res = 1.0 if w == 'red' else 0.0
        elif w == '' and m['cl'] == 'qm':
            res = 0.5
        else:
            res = 1.0 if rs > bs else 0.0 if bs > rs else 0.5
        out.append({
            'key': m['k'], 'event': m['e'], 'week': e.get('week'), 'etype': e.get('type'),
            'elim': m['cl'] != 'qm', 't': t, 'cl': CL[m['cl']], 'n': m['n'],
            'red': r['t'], 'blue': b['t'],
            'rs': float(rs), 'bs': float(bs), 'rnf': nf(r), 'bnf': nf(b),
            'rauto': r.get('auto') if r.get('auto') is not None else (r.get('bd') or {}).get('totalAutoPoints'),
            'bauto': b.get('auto') if b.get('auto') is not None else (b.get('bd') or {}).get('totalAutoPoints'),
            'rtele': r.get('tele'), 'btele': b.get('tele'),
            'res': res,
            'rbd': r.get('bd') or {}, 'bbd': b.get('bd') or {},
        })
    out.sort(key=lambda m: (m['t'], m['cl'], m['n']))
    return out, ev


def year_constants(ms):
    """Statbotics-style constants from week-1 (TBA week 0) matches."""
    w1 = [m for m in ms if m['week'] == 0] or ms[: max(100, len(ms) // 10)]
    sc = [m['rs'] for m in w1] + [m['bs'] for m in w1]
    nf = [m['rnf'] for m in w1] + [m['bnf'] for m in w1]
    mean = float(np.mean(sc)); sd = float(np.std(sc, ddof=1)); nfm = float(np.mean(nf))
    return {'mean': mean, 'sd': sd, 'nf_mean': nfm, 'foul_rate': (mean - nfm) / max(nfm, 1)}


def metrics(ps, ys):
    ps = np.clip(np.asarray(ps, float), 1e-6, 1 - 1e-6)
    ys = np.asarray(ys, float)
    keep = ys != 0.5
    p, y = ps[keep], ys[keep]
    brier = float(np.mean((p - y) ** 2))
    ll = float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
    acc = float(np.mean((p > 0.5) == (y == 1)))
    return {'n': int(keep.sum()), 'brier': brier, 'logloss': ll, 'acc': acc}


def fmt(mt):
    return f"n={mt['n']:6d}  acc={mt['acc']*100:5.2f}%  brier={mt['brier']:.4f}  logloss={mt['logloss']:.4f}"
