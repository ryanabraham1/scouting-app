"""Scalar replica of the Statbotics v3 EPA model (backend/src/models/epa/*).

Exact for years whose score model is `no_foul_points` (2016*, 2017*, 2019, 2020,
2022, 2024, 2025*, 2026). 2018/2023 use non-linear breakdown models upstream,
so the replica is approximate there. (*minor elim-RP / processor-algae tweaks
not replicated.)
"""
from bisect import bisect_left
from collections import defaultdict
import numpy as np
from scipy.stats import expon, exponnorm
from common import load_year, year_constants

NORM_MEAN, NORM_SD, INIT_PENALTY = 1500, 250, 0.2
YEAR_ONE_WEIGHT, MEAN_REVERSION, ELIM_WEIGHT = 0.7, 0.4, 1 / 3
K = -5 / 8
_distrib = exponnorm(1.6, -0.3, 0.2)


def norm_func(year_epas):
    d = sorted(year_epas, reverse=True)
    N, cut = len(d), len(d) // 10
    en = exponnorm(*exponnorm.fit(d))
    ex = expon(*expon.fit(d[:cut])) if cut > 0 else None
    s = d[::-1]

    def _norm(epa):
        i = N - bisect_left(s, epa)
        pct = en.cdf(epa)
        if i < cut:
            ev = 1 - cut / N * (1 - ex.cdf(epa))
            f = min(1, 2 * (cut - i) / cut)
            pct = f * ev + (1 - f) * pct
        return NORM_MEAN + NORM_SD * _distrib.ppf(pct)

    q = [s[((N - 1) * i) // 100] for i in range(101)]
    qn = [_norm(x) for x in q]

    def f(epa):
        i = bisect_left(q, epa)
        if i == 0:
            return qn[0]
        if i == 101:
            return qn[100]
        x0, x1 = q[i - 1], q[i]
        return qn[i - 1] + (qn[i] - qn[i - 1]) * (epa - x0) / (x1 - x0) if x1 > x0 else qn[i]
    return f


def percent(n):
    return 2 / 3 * min(0.5, max(0.3, 0.5 - 0.2 / 6 * (n - 6)))


class StatboticsEPA:
    name = 'statbotics'

    def __init__(self):
        self.norm_hist = {}  # year -> {team: norm_epa}

    def start_season(self, y, ms):
        c = year_constants(ms)
        self.c = c
        mean, sd = c['nf_mean'], c['sd']
        init_norm = NORM_MEAN - INIT_PENALTY * NORM_SD

        def init(team):
            past = [self.norm_hist[py][team] for py in range(y - 1, y - 5, -1)
                    if py in self.norm_hist and team in self.norm_hist[py]]
            n1 = past[0] if len(past) > 0 else init_norm
            n2 = past[1] if len(past) > 1 else init_norm
            prev = YEAR_ONE_WEIGHT * n1 + (1 - YEAR_ONE_WEIGHT) * n2
            cur = (1 - MEAN_REVERSION) * prev + MEAN_REVERSION * init_norm
            z = max(-mean / 3 / sd, (cur - NORM_MEAN) / NORM_SD)
            return mean / 3 + sd * z
        self.epa = {}
        self._init = init
        self.cnt = defaultdict(int)

    def get(self, t):
        if t not in self.epa:
            self.epa[t] = self._init(t)
        return self.epa[t]

    def predict(self, m):
        r = sum(self.get(t) for t in m['red'])
        b = sum(self.get(t) for t in m['blue'])
        self._snap = (r, b)
        return 1 / (1 + 10 ** (K * (r - b) / self.c['sd']))

    def update(self, m):
        r, b = self._snap
        w = ELIM_WEIGHT if m['elim'] else 1
        for teams, pred, obs in ((m['red'], r, m['rnf']), (m['blue'], b, m['bnf'])):
            err = (obs - pred) / 3
            for t in teams:
                self.epa[t] = self.get(t) + w * percent(self.cnt[t]) * err
        if not m['elim']:
            for t in m['red'] + m['blue']:
                self.cnt[t] += 1

    def end_season(self, y):
        f = norm_func(list(self.epa.values()))
        self.norm_hist[y] = {t: f(e) for t, e in self.epa.items()}
