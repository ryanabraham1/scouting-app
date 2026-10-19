"""Two-stream full-covariance model: autonomous points and the rest (teleop+endgame),
each its own exact within-event posterior with its own noise. Total = sum."""
import math
import numpy as np
from scipy.special import ndtr
from scipy.stats import norm
from kal3 import FullCovEPA


def comp_view(m, which):
    ra, ba = m['rauto'], m['bauto']
    if ra is None or ba is None:
        ra, ba = 0.27 * m['rnf'], 0.27 * m['bnf']   # fallback split if no breakdown
    ra, ba = min(ra, m['rnf']), min(ba, m['bnf'])
    if which == 'auto':
        r, b = ra, ba
    else:
        r, b = m['rnf'] - ra, m['bnf'] - ba
    v = dict(m); v['rnf'] = v['rs'] = float(r); v['bnf'] = v['bs'] = float(b)
    return v


class TwoStreamEPA:
    def __init__(self, auto=None, rest=None, c=1.3, cal_n=100, cal_every=50, rho_ar=0.0, **shared):
        a = dict(shared, **(auto or {})); r = dict(shared, **(rest or {}))
        a.update(cal_n=0); r.update(cal_n=0)
        self.A, self.B = FullCovEPA(**a), FullCovEPA(**r)
        self.p = dict(c=c, cal_n=cal_n, cal_every=cal_every, rho_ar=rho_ar)

    def start_season(self, y, ms):
        self.A.start_season(y, [comp_view(m, 'auto') for m in ms])
        self.B.start_season(y, [comp_view(m, 'rest') for m in ms])
        self.zs, self.os, self.cs = [], [], self.p['c']

    def predict(self, m):
        self.A.predict(comp_view(m, 'auto')); self.B.predict(comp_view(m, 'rest'))
        (ar, ab, av), (br, bb, bv) = self.A.last_mu, self.B.last_mu
        v = av + bv + 2 * self.p['rho_ar'] * math.sqrt(av * bv)
        self._z = (ar + br - ab - bb) / math.sqrt(v)
        self.last_mu = (ar + br, ab + bb, v)
        return float(ndtr(self.cs * self._z))

    def update(self, m):
        self.A.update(comp_view(m, 'auto')); self.B.update(comp_view(m, 'rest'))
        if self.p['cal_n']:
            self.zs.append(self._z); self.os.append(m['res'])
            if len(self.zs) % self.p['cal_every'] == 0:
                self._refit()

    def _refit(self):
        z = np.array(self.zs); y = np.array(self.os); k = y != 0.5; z, y = z[k], y[k]
        c0, lam = self.p['c'], self.p['cal_n'] * 0.16
        c = self.cs
        for _ in range(20):
            p = np.clip(ndtr(c * z), 1e-9, 1 - 1e-9); phi = norm.pdf(c * z)
            g = np.sum((y - p) * phi * z / (p * (1 - p))) - lam * (c - c0)
            h = -np.sum(phi ** 2 * z ** 2 / (p * (1 - p))) - lam
            step = g / h; c -= step
            if abs(step) < 1e-5: break
        self.cs = float(min(3.0, max(0.5, c)))

    def end_season(self, y):
        self.A.end_season(y); self.B.end_season(y)
