"""Full-covariance (within-event) Bayesian team-strength model.

Exact Gaussian posterior over all teams at an event (= ridge OPR with a
carry-over prior, solved recursively), so evidence about a partner flows back
into a team's rating. Across events, each team's marginal (mean, var) carries
forward with extra process noise. Prior/noise structure as in kal2.
"""
import math
import numpy as np
from scipy.special import ndtr
from common import year_constants
import kal2

DEFAULTS = dict(kal2.DEFAULTS)
DEFAULTS.update(
    cal_n=0,        # online in-season calibration: prior strength in pseudo-matches (0 = off)
    cal_every=200,  # refit cadence (matches)
    rho=0.0,        # correlation of red/blue score noise within a match
    r_n=0,          # online noise estimation: prior strength in pseudo-observations (0 = off)
)


class EventState:
    __slots__ = ('idx', 'teams', 'mu', 'P', 'n')

    def __init__(self, cap=96):
        self.idx = {}; self.teams = []
        self.mu = np.zeros(cap); self.P = np.zeros((cap, cap)); self.n = 0

    def add(self, t, mu, var):
        if self.n == len(self.mu):
            cap = 2 * self.n
            mu2 = np.zeros(cap); mu2[:self.n] = self.mu
            P2 = np.zeros((cap, cap)); P2[:self.n, :self.n] = self.P
            self.mu, self.P = mu2, P2
        i = self.n; self.n += 1
        self.idx[t] = i; self.teams.append(t)
        self.mu[i] = mu; self.P[i, :] = 0; self.P[:, i] = 0; self.P[i, i] = var
        return i


class FullCovEPA:
    def __init__(self, **kw):
        self.p = dict(DEFAULTS, **kw)
        self.hist = {}

    def start_season(self, y, ms):
        self.c = year_constants(ms); self.sd2 = self.c['sd'] ** 2; self.mean = self.c['nf_mean']
        self.y = y
        self.where = {}      # team -> event key it currently lives in
        self.events = {}     # event -> EventState
        self.last_t = {}
        self.final = {}      # team -> last known marginal mean
        self.zs, self.os = [], []   # this season's raw z and outcomes (for online calibration)
        self.cs = self.p['c']
        self.rm = 1.0; self.r_e2 = 0.0; self.r_hph = 0.0; self.r_cnt = 0

    def _prior(self, t):
        p = self.p
        past = [py for py in range(self.y - 1, self.y - 5, -1) if py in self.hist and t in self.hist[py]]
        if past:
            z1 = self.hist[past[0]][t]
            z2 = self.hist[past[1]][t] if len(past) > 1 else p['new_z']
            z3 = self.hist[past[2]][t] if len(past) > 2 else z2
            zp = (1 - p['y3w']) * (p['y1w'] * z1 + (1 - p['y1w']) * z2) + p['y3w'] * z3
            z = (1 - p['revert']) * zp + p['revert'] * p['new_z']; var = p['p0_vet']
        else:
            z, var = p['new_z'], p['p0_new']
        return max(0.0, self.mean / 3 + p['zscale'] * self.c['sd'] * z), var * self.sd2

    def _marg(self, t):
        es = self.events[self.where[t]]; i = es.idx[t]
        return es.mu[i], es.P[i, i]

    def _prep(self, t, ev, now):
        es = self.events.get(ev)
        if es is None:
            es = self.events[ev] = EventState()
        if t in es.idx and self.where.get(t) == ev:
            i = es.idx[t]
        else:
            if t in self.where:
                mu, var = self._marg(t)
                var += self.p['q_event'] * self.sd2
            else:
                mu, var = self._prior(t)
            if t in es.idx:  # returning to an event after visiting another (rare)
                i = es.idx[t]; es.mu[i] = mu
                es.P[i, :] = 0; es.P[:, i] = 0; es.P[i, i] = var
            else:
                i = es.add(t, mu, var)
            self.where[t] = ev
        if self.p['q_day'] and t in self.last_t:
            days = max(0.0, (now - self.last_t[t]) / 86400)
            es.P[i, i] += self.p['q_day'] * self.sd2 * min(days, 60)
        self.last_t[t] = now
        return i

    def _R(self, pred, elim):
        p = self.p
        R = p['R'] * self.rm * self.sd2 * (p['elim_R'] if elim else 1)
        if p['het']:
            R *= max(0.25, pred / self.mean) ** p['het']
        return R

    def predict(self, m):
        ev = m['event']
        ri = [self._prep(t, ev, m['t']) for t in m['red']]
        bi = [self._prep(t, ev, m['t']) for t in m['blue']]
        es = self.events[ev]; n = es.n
        mu, P = es.mu[:n], es.P[:n, :n]
        pr, pb = mu[ri].sum(), mu[bi].sum()
        vdiff = P[np.ix_(ri, ri)].sum() + P[np.ix_(bi, bi)].sum() - 2 * P[np.ix_(ri, bi)].sum()
        Rr, Rb = self._R(pr, m['elim']), self._R(pb, m['elim'])
        self._snap = (ri, bi, Rr, Rb)
        vtot = vdiff + Rr + Rb - 2 * self.p['rho'] * math.sqrt(Rr * Rb)
        self.last_mu = (pr, pb, vtot)
        z = (pr - pb) / math.sqrt(vtot)
        self._z = z
        return float(ndtr(self.cs * z))

    def _refit(self):
        # MAP fit of the probit slope c on this season's played matches, shrunk to prior c
        z = np.array(self.zs); y = np.array(self.os); k = y != 0.5; z, y = z[k], y[k]
        c0, n0 = self.p['c'], self.p['cal_n']
        c = self.cs
        from scipy.stats import norm
        for _ in range(20):
            p = np.clip(ndtr(c * z), 1e-9, 1 - 1e-9); phi = norm.pdf(c * z)
            g = np.sum((y - p) * phi * z / (p * (1 - p))) - n0 * (c - c0) / 0.25 ** 2 / len(z) * len(z) / max(1, len(z)) * 0 - (c - c0) * n0 / 0.0625 / 100
            h = -np.sum(phi ** 2 * z ** 2 / (p * (1 - p))) - n0 / 0.0625 / 100
            step = g / h; c -= step
            if abs(step) < 1e-5: break
        self.cs = float(min(3.0, max(0.5, c)))

    def update(self, m):
        ri, bi, Rr, Rb = self._snap
        es = self.events[m['event']]; n = es.n
        mu, P = es.mu[:n], es.P[:n, :n]
        if self.p['rho']:
            # joint update of both alliance scores with correlated noise
            A = P[:, ri].sum(axis=1); B = P[:, bi].sum(axis=1)   # P h_r', P h_b'
            Crr = A[ri].sum() + Rr; Cbb = B[bi].sum() + Rb
            Crb = A[bi].sum() + self.p['rho'] * math.sqrt(Rr * Rb)
            det = Crr * Cbb - Crb * Crb
            er = m['rnf'] - mu[ri].sum(); eb = m['bnf'] - mu[bi].sum()
            # S^-1 e
            wr = (Cbb * er - Crb * eb) / det; wb = (Crr * eb - Crb * er) / det
            mu += A * wr + B * wb
            # P -= [A B] S^-1 [A B]'
            P -= (np.outer(A, A) * Cbb - (np.outer(A, B) + np.outer(B, A)) * Crb + np.outer(B, B) * Crr) / det
            if self.p['r_n']: pass
            idxs = []
        else:
            idxs = ((ri, Rr, m['rnf']), (bi, Rb, m['bnf']))
        for idx, R, obs in idxs:
            Ph = P[:, idx].sum(axis=1)
            S = Ph[idx].sum() + R
            err = obs - mu[idx].sum()
            if self.p['r_n']:
                # method-of-moments: E[err^2] = hPh + R  ->  R_hat ratio vs nominal R
                self.r_e2 += (err * err - (S - R)) / R; self.r_cnt += 1
            K = Ph / S
            mu += K * err
            P -= np.outer(K, Ph)
        if self.p['r_n'] and self.r_cnt:
            n0 = self.p['r_n']
            self.rm = max(0.3, min(3.0, (n0 * 1.0 + self.r_e2 * self.rm) / (n0 + self.r_cnt)))
        if self.p['cal_n']:
            self.zs.append(self._z); self.os.append(m['res'])
            if len(self.zs) % self.p['cal_every'] == 0:
                self._refit()
        q = self.p['q'] * self.sd2
        for i in ri + bi:
            P[i, i] += q
            if mu[i] < 0: mu[i] = 0.0

    def end_season(self, y):
        vals = {t: self._marg(t)[0] for t in self.where}
        v = np.array(list(vals.values())); m0, s0 = v.mean(), v.std()
        self.hist[y] = {t: (x - m0) / s0 for t, x in vals.items()}
