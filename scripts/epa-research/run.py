"""Sequential, strictly pre-match backtest: predict -> score -> update."""
import sys
from collections import defaultdict
from common import load_year, metrics, fmt

YEARS = [2016, 2017, 2018, 2019, 2020, 2022, 2023, 2024, 2025, 2026]


def backtest(model, years=YEARS, record=None):
    """Returns {year: (preds, outcomes, matches)}."""
    out = {}
    for y in years:
        d = load_year(y)
        if d is None:
            continue
        ms, _ = d
        model.start_season(y, ms)
        ps, ys = [], []
        for m in ms:
            p = model.predict(m)
            ps.append(p); ys.append(m['res'])
            model.update(m)
        model.end_season(y)
        out[y] = (ps, ys, ms)
    return out


def report(name, res, years=None):
    print(f'== {name}')
    allp, ally = [], []
    for y, (ps, ys, ms) in res.items():
        if years and y not in years:
            continue
        print(f'  {y}: {fmt(metrics(ps, ys))}')
        allp += ps; ally += ys
    print(f'  ALL : {fmt(metrics(allp, ally))}')


if __name__ == '__main__':
    from sb import StatboticsEPA
    r = backtest(StatboticsEPA())
    report('statbotics replica', r)
