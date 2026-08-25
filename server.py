#!/usr/bin/env python3
import json, os, urllib.error, urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/api/ai':
            self.send_error(404); return
        try:
            size = int(self.headers.get('Content-Length', 0))
            req = json.loads(self.rfile.read(size))
            upstream = urllib.request.Request(req['url'], data=json.dumps(req['body']).encode(), method='POST', headers={'Content-Type':'application/json','Authorization':'Bearer '+req['key']})
            with urllib.request.urlopen(upstream, timeout=120) as response:
                data, status, content_type = response.read(), response.status, response.headers.get('Content-Type','application/json')
            self.send_response(status); self.send_header('Content-Type', content_type); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
        except urllib.error.HTTPError as e:
            self.send_json(e.code, {'error': e.read().decode('utf-8', 'replace')})
        except Exception as e:
            self.send_json(502, {'error': str(e)})

    def send_json(self, status, value):
        data=json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)

if __name__ == '__main__':
    port=int(os.environ.get('PORT','8000')); os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f'TeamAsk 已启动: http://localhost:{port}')
    ThreadingHTTPServer(('0.0.0.0',port), Handler).serve_forever()
