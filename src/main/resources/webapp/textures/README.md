# Scene maps

Loaded by both views, `/` and `/?mode=craive` (`SolarSystemScene` quality `high` / `band`).
`quality: 'cheap'` keeps the procedural stripes and skips these files.

| file | source |
|---|---|
| `planets/*.jpg` | [Solar System Scope](https://www.solarsystemscope.com/textures/) 2K equirectangular maps, NASA/JPL imagery, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `planets/saturn-ring.png` | Solar System Scope Saturn ring (colour + alpha), same licence |
| `sky/milkyway.jpg` | NASA SVS [Deep Star Maps](https://svs.gsfc.nasa.gov/3895/) 8K celestial plate carrée, public domain |

Star positions in `../data/bsc.json` are HYG v3.8 (Hipparcos / Yale BSC / Gliese), mag ≤ 6, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Rebuild with `python tools/build-stars.py`.
