#!/usr/bin/env python3
"""Kehityspalvelin ilman välimuistia.

`python3 -m http.server` ei lähetä Cache-Control-otsakkeita, joten selain voi
tarjota vanhan ES-moduulin tavallisella reloadilla — ja jos vain osa moduuleista
päivittyy, importit voivat mennä ristiin (SyntaxError). Tämä palvelin pakottaa
`no-store`-otsakkeen, jolloin jokainen lataus hakee tuoreet tiedostot.

Käyttö: python3 serve.py   → http://localhost:8741
"""
import http.server
import json
import math
from pathlib import Path
import socketserver

PORT = 8741
ROOT = Path(__file__).resolve().parent
PLASMA_METER_CONFIG = ROOT / 'js' / 'plasmaMeterConfig.js'


def _format_plasma_meter_config(corners):
    lines = ['export const PLASMA_METER_CORNERS = [']
    for p in corners:
        lines.append(f"  {{ x: {p['x']:.3f}, y: {p['y']:.3f}, z: {p['z']:.3f} }},")
    lines.append('];')
    return '\n'.join(lines) + '\n'


def _validate_corners(data):
    corners = data.get('corners') if isinstance(data, dict) else None
    if not isinstance(corners, list) or len(corners) != 4:
        raise ValueError('Expected exactly four corners')
    out = []
    for p in corners:
        if not isinstance(p, dict):
            raise ValueError('Corner must be an object')
        q = {axis: float(p[axis]) for axis in ('x', 'y', 'z')}
        if not all(math.isfinite(v) for v in q.values()):
            raise ValueError('Corner coordinates must be finite numbers')
        if not all(-2.0 <= v <= 2.0 for v in q.values()):
            raise ValueError('Corner coordinates are outside the viewmodel range')
        out.append(q)
    return out


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/__dev/plasma-meter-corners':
            self.send_error(404, 'Unknown endpoint')
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length > 4096:
                raise ValueError('Payload too large')
            payload = self.rfile.read(length).decode('utf-8')
            corners = _validate_corners(json.loads(payload))
            PLASMA_METER_CONFIG.write_text(_format_plasma_meter_config(corners), encoding='utf-8')
            body = json.dumps({'ok': True, 'file': 'js/plasmaMeterConfig.js'}).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as err:
            body = json.dumps({'ok': False, 'error': str(err)}).encode('utf-8')
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('', PORT), NoCacheHandler) as httpd:
        print(f'No-cache server: http://localhost:{PORT}')
        httpd.serve_forever()
