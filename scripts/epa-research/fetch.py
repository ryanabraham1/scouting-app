import re, json, os, sys, gzip, urllib.request, concurrent.futures as cf, time
KEY = os.environ['TBA_API_KEY']
BASE = 'https://www.thebluealliance.com/api/v3'
def get(path, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(BASE + path, headers={'X-TBA-Auth-Key': KEY, 'User-Agent': 'curl/8.7.1'})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:
            time.sleep(2 * (i + 1))
    print('FAIL', path, file=sys.stderr); return None

def slim(m):
    out = {'k': m['key'], 'e': m['event_key'], 'cl': m['comp_level'], 's': m.get('set_number'),
           'n': m['match_number'], 't': m.get('actual_time') or m.get('predicted_time') or m.get('time'),
           'w': m.get('winning_alliance')}
    sb = m.get('score_breakdown') or {}
    for c in ('red', 'blue'):
        a = m['alliances'][c]
        bd = sb.get(c) or {}
        out[c] = {'t': [int((re.search(r'\d+', x) or re.search('0','0')).group()) for x in a['team_keys']],
                  'sur': a.get('surrogate_team_keys') or [], 'dq': a.get('dq_team_keys') or [],
                  'sc': a['score'],
                  'auto': bd.get('autoPoints'), 'tele': bd.get('teleopPoints'),
                  'foul': bd.get('foulPoints'), 'adj': bd.get('adjustPoints'),
                  'bd': {k: v for k, v in bd.items() if isinstance(v, (int, float, bool)) and ('Points' in k or 'RankingPoint' in k or k.startswith('rp') or 'Bonus' in k)}}
    return out

def year(y):
    fn = f'data/{y}.json.gz'
    if os.path.exists(fn): return
    events = get(f'/events/{y}')
    evmeta = {e['key']: {'type': e['event_type'], 'week': e.get('week'), 'dist': (e.get('district') or {}).get('abbreviation'),
                        'start': e.get('start_date'), 'country': e.get('country')} for e in events}
    def ev(k):
        ms = get(f'/event/{k}/matches') or []
        return [slim(m) for m in ms if m['alliances']['red']['score'] is not None and m['alliances']['red']['score'] >= 0]
    allm = []
    with cf.ThreadPoolExecutor(12) as ex:
        for r in ex.map(ev, list(evmeta)):
            allm.extend(r)
    with gzip.open(fn, 'wt') as f:
        json.dump({'events': evmeta, 'matches': allm}, f)
    print(y, len(events), 'events', len(allm), 'matches', flush=True)

for y in sys.argv[1:]:
    year(int(y))
