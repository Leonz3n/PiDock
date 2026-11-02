#!/usr/bin/env python3
"""Validate and package only this handoff directory. Standard library; no network."""
import hashlib
import json
import re
import struct
import zipfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT.parent / 'pidock-stitch-apple-2026-11-02.zip'


def jpeg_size(path):
    data = path.read_bytes()
    assert data[:2] == b'\xff\xd8', f'Not JPEG: {path}'
    offset = 2
    while offset < len(data):
        assert data[offset] == 255, f'Invalid JPEG marker: {path}'
        while data[offset] == 255:
            offset += 1
        marker = data[offset]
        offset += 1
        length = int.from_bytes(data[offset:offset + 2], 'big')
        if marker in (192, 193, 194):
            height, width = struct.unpack('>HH', data[offset + 3:offset + 7])
            return width, height
        offset += length
    raise ValueError(f'No JPEG dimensions: {path}')


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


files = sorted(path for path in ROOT.rglob('*') if path.is_file()
               and not any(part.startswith('.') or part == '__pycache__'
                           for part in path.relative_to(ROOT).parts)
               and path.name != 'MANIFEST.json')
assert all(not path.is_symlink() for path in files), 'Do not package symlinks'
assert all(path.suffix in {'.md', '.json', '.css', '.py', '.jpg'} for path in files)
for path in files:
    if path.suffix == '.json':
        json.loads(path.read_text())
    if path.suffix in {'.md', '.css', '.py', '.json'}:
        text = path.read_text()
        assert text.endswith('\n'), f'Missing final newline: {path}'
        assert all(line == line.rstrip() for line in text.splitlines()), f'Trailing whitespace: {path}'
    if path.suffix == '.md':
        for target in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', text):
            target = target.strip().strip('<>')
            if urlsplit(target).scheme or target.startswith('#'):
                continue
            linked = (path.parent / unquote(target.split('#')[0])).resolve()
            assert linked.is_relative_to(ROOT), f'Link leaves package: {path}: {target}'
            assert linked.exists(), f'Broken link: {path}: {target}'

images = sorted((ROOT / 'reference').glob('*.jpg'))
assert len(images) == 14, 'Expected 14 reference images'
dimensions = {}
for path in images:
    expected = ((720, 524) if path.name.startswith('13-') else
                (1440, 900) if path.name.startswith('04-') else (1440, 860))
    actual = jpeg_size(path)
    assert actual == expected, f'{path.name}: {actual} != {expected}'
    dimensions[path.name] = list(actual)

manifest = {
    'package': 'PiDock Apple Flat · Google Stitch handoff',
    'date': '2026-11-02',
    'source': 'See SOURCES.md; screenshots are fictional local prototype data.',
    'scope': 'Only stitch-apple/; no production source, credentials, or sibling design package.',
    'hashAlgorithm': 'SHA-256',
    'manifestExcludedFromHashes': True,
    'referenceDimensions': dimensions,
    'files': [{'path': str(path.relative_to(ROOT)), 'bytes': path.stat().st_size,
               'sha256': sha256(path)} for path in files],
}
manifest_path = ROOT / 'MANIFEST.json'
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
with zipfile.ZipFile(ARCHIVE, 'w', zipfile.ZIP_DEFLATED) as bundle:
    for path in sorted(files + [manifest_path]):
        bundle.write(path, 'stitch-apple/' + str(path.relative_to(ROOT)))
with zipfile.ZipFile(ARCHIVE) as bundle:
    assert bundle.testzip() is None, 'ZIP CRC failure'
    for entry in manifest['files']:
        actual = hashlib.sha256(bundle.read('stitch-apple/' + entry['path'])).hexdigest()
        assert actual == entry['sha256'], f'ZIP hash mismatch: {entry["path"]}'
print(json.dumps({'files': len(files) + 1, 'images': len(images),
                  'archive': str(ARCHIVE), 'bytes': ARCHIVE.stat().st_size,
                  'sha256': sha256(ARCHIVE)}, ensure_ascii=False, indent=2))
