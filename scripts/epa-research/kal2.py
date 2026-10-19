"""Kalman offense + defense, heteroscedastic noise. Superset of kal.KalmanEPA."""
import math
import numpy as np
from scipy.special import ndtr
from common import year_constants

TUNED1 = {"p0_vet": 0.0784375, "revert": 0.45625, "new_z": -1.325, "c": 1.25, "elim_R": 1.3125,
          "q": 0.00025, "zscale": 0.46875, "q_event": 0.01125, "p0_new": 0.124375}
DEFAULTS = dict(R=0.45, q=0.004, q_event=0.03, p0_vet=0.06, p0_new=0.10, revert=0.4, y1w=0.7,
                new_z=-0.2, zscale=0.35, c=1.0, elim_R=1.0,
                p0_def=0.0,     # prior var of defense rating / sd^2 (0 disables)
                q_def=0.0,
                het=0.0,        # R scales with (pred/mean)^het
                def_carry=0.0,  # carry-over fraction of defense z
                q_day=0.0,      # process noise per day since team's last match / sd^2
                y3w=0.0,        # weight on 3 seasons ago (taken from the y1/y2 mix)
                h_neg=99.0,     # robust (Huber) clip of negative innovations, in innovation SDs
                h_pos=99.0,     # robust clip of positive innovations
                )
DEFAULTS.update({"het": 0.65625, "p0_def": 0.00125, "q_def": 0.0003125, "c": 1.325, "q_day": 0.0005,
                 "y3w": 0.21875, "y1w": 0.83125, "p0_new": 0.089375, "elim_R": 1.0, "q_event": 0.01625,
                 "revert": 0.5125, "p0_vet": 0.0665625, "new_z": -1.16875})
DEFAULTS.update(TUNED1)


class KalmanEPA2:
    def __init__(self, **kw):
        self.p = dict(DEFAULTS, **kw)
        self.hist = {}; self.dhist = {}

    def start_season(self, y, ms):
        self.c = year_constants(ms); self.sd2 = self.c['sd'] ** 2; self.mean = self.c['nf_mean']
        self.mu, self.P, self.d, self.D, self.last_event, self.last_t = {}, {}, {}, {}, {}, {}
        self.y = y

    def _init(self, t):
        p = self.p
        past = [py for py in range(self.y - 1, self.y - 5, -1) if py in self.hist and t in self.hist[py]]
        if past:
            z1 = self.hist[past[0]][t]
            z2 = self.hist[past[1]][t] if len(past) > 1 else p['new_z']
            z3 = self.hist[past[2]][t] if len(past) > 2 else z2
            zp = (1 - p['y3w']) * (p['y1w'] * z1 + (1 - p['y1w']) * z2) + p['y3w'] * z3
            z = (1 - p['revert']) * zp + p['revert'] * p['new_z']
            var = p['p0_vet']
            dz = self.dhist[past[0]].get(t, 0.0) * p['def_carry']
        else:
            z, var, dz = p['new_z'], p['p0_new'], 0.0
        sd = self.c['sd']
        self.mu[t] = max(0.0, self.mean / 3 + p['zscale'] * sd * z)
        self.P[t] = var * self.sd2
        self.d[t] = dz * sd
        self.D[t] = p['p0_def'] * self.sd2

    def _prep(self, t, ev, now):
        if t not in self.mu:
            self._init(t); self.last_event[t] = ev
        else:
            if self.last_event.get(t) != ev:
                self.P[t] += self.p['q_event'] * self.sd2; self.last_event[t] = ev
            if self.p['q_day'] and t in self.last_t:
                days = max(0.0, (now - self.last_t[t]) / 86400)
                self.P[t] += self.p['q_day'] * self.sd2 * min(days, 60)
        self.last_t[t] = now

    def _R(self, pred, elim):
        p = self.p
        R = p['R'] * self.sd2 * (p['elim_R'] if elim else 1)
        if p['het']:
            R *= max(0.25, pred / self.mean) ** p['het']
        return R

    def predict(self, m):
        for t in m['red'] + m['blue']:
            self._prep(t, m['event'], m['t'])
        R_, B_ = m['red'], m['blue']
        pr = sum(self.mu[t] for t in R_) - sum(self.d[t] for t in B_)
        pb = sum(self.mu[t] for t in B_) - sum(self.d[t] for t in R_)
        vr = sum(self.P[t] for t in R_) + sum(self.D[t] for t in B_)
        vb = sum(self.P[t] for t in B_) + sum(self.D[t] for t in R_)
        Rr, Rb = self._R(pr, m['elim']), self._R(pb, m['elim'])
        self._snap = (pr, pb, vr, vb, Rr, Rb)
        self.last_mu = (pr, pb, vr + vb + Rr + Rb)
        z = self.p['c'] * (pr - pb) / math.sqrt(vr + vb + Rr + Rb)
        return float(ndtr(z))

    def update(self, m):
        pr, pb, vr, vb, Rr, Rb = self._snap
        q = self.p['q'] * self.sd2; qd = self.p['q_def'] * self.sd2
        for off, dfn, pred, v, R, obs in ((m['red'], m['blue'], pr, vr, Rr, m['rnf']),
                                          (m['blue'], m['red'], pb, vb, Rb, m['bnf'])):
            S = v + R; err = obs - pred
            sS = math.sqrt(S)
            err = max(-self.p['h_neg'] * sS, min(self.p['h_pos'] * sS, err))
            for t in off:
                k = self.P[t] / S
                self.mu[t] = max(0.0, self.mu[t] + k * err)
                self.P[t] = self.P[t] * (1 - k) + q
            if self.p['p0_def'] > 0:
                for t in dfn:
                    k = self.D[t] / S
                    self.d[t] -= k * err
                    self.D[t] = self.D[t] * (1 - k) + qd

    def end_season(self, y):
        v = np.array(list(self.mu.values())); m0, s0 = v.mean(), v.std()
        self.hist[y] = {t: (mu - m0) / s0 for t, mu in self.mu.items()}
        sd = self.c['sd']
        self.dhist[y] = {t: d / sd for t, d in self.d.items()}
