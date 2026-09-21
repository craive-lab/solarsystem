"""Filter HYG v3.8 to a mag<=6 catalog for the CRAIVE sky."""
import csv
import gzip
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
src = root / 'src/main/resources/webapp/data/hyg_v38.csv.gz'
dst = root / 'src/main/resources/webapp/data/bsc.json'

rows = []
with gzip.open(src, 'rt', encoding='utf-8', newline='') as f:
    for row in csv.DictReader(f):
        try:
            mag = float(row['mag'])
        except (TypeError, ValueError):
            continue
        if mag > 6.0 or mag < -5:
            continue
        try:
            ra = float(row['rarad'])
            dec = float(row['decrad'])
        except (TypeError, ValueError):
            continue
        try:
            bv = float(row.get('ci') or 0.0)
        except ValueError:
            bv = 0.0
        rows.append([round(ra, 5), round(dec, 5), round(mag, 2), round(bv, 2)])

rows.sort(key=lambda x: x[2])
dst.write_text(
    json.dumps({'source': 'HYG v3.8, mag<=6', 'stars': rows}, separators=(',', ':')),
    encoding='utf-8'
)
print(f'{len(rows)} stars, {dst.stat().st_size} bytes')
