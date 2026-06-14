#!/usr/bin/env python3
"""Kehityspalvelin ilman välimuistia.

`python3 -m http.server` ei lähetä Cache-Control-otsakkeita, joten selain voi
tarjota vanhan ES-moduulin tavallisella reloadilla — ja jos vain osa moduuleista
päivittyy, importit voivat mennä ristiin (SyntaxError). Tämä palvelin pakottaa
`no-store`-otsakkeen, jolloin jokainen lataus hakee tuoreet tiedostot.

Käyttö: python3 serve.py   → http://localhost:8741
"""
import http.server
import socketserver

PORT = 8741


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
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
