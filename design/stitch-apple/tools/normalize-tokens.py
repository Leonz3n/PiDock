#!/usr/bin/env python3
"""Correct comma-separated font stacks from @google/design.md 0.4.0 exports."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def families(value):
    values = value if isinstance(value, list) else [value]
    return [part.strip().strip('\"\'') for item in values for part in item.split(',')]


def normalize(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == 'fontFamily' and isinstance(child, (str, list)):
                value[key] = families(child)
            else:
                normalize(child)
    elif isinstance(value, list):
        for child in value:
            normalize(child)


for name in ('design_tokens.json', 'tailwind.theme.json'):
    path = ROOT / 'tokens' / name
    data = json.loads(path.read_text())
    if name == 'tailwind.theme.json':
        fonts = data['theme']['extend']['fontFamily']
        for key, value in fonts.items():
            fonts[key] = families(value)
    else:
        normalize(data)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')

path = ROOT / 'tokens/theme.css'
css = path.read_text()
css = re.sub(r'(--font-[\w-]+:) "([^"\n]*,[^"\n]*)";',
             lambda match: match[1] + ' ' + ', '.join(
                 json.dumps(font) if ' ' in font else font
                 for font in families(match[2])) + ';', css)
path.write_text(css)
print('Normalized DTCG, Tailwind v3 and Tailwind v4 font stacks.')
