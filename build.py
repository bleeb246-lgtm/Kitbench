"""Assemble index.html from src/. Needs: npm i manifold-3d@3.4.1"""
import base64, re
M = 'node_modules/manifold-3d/'
mf = open(M + 'manifold.js').read().rstrip()
mf = mf[:-len('export default Module;')] + 'window.ManifoldModule=Module;'
mf = mf.replace('import.meta.url', '"https://kitbench.local/"').replace('await import("node:module")', '({createRequire:null})')
wasm = base64.b64encode(open(M + 'manifold.wasm', 'rb').read()).decode()
body = open('src/shell.html').read() + '''
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
<script type="application/octet-stream" id="mfwasm">''' + wasm + '''</script>
<script>/* manifold-3d 3.4.1, Apache-2.0, https://github.com/elalish/manifold */
''' + mf + '''</script>
''' + ''.join('<script>' + open('src/' + f).read() + '</script>\n' for f in ('geom.js', 'vision.js', 'app.js'))
head = open('index.html').read()
head = head[:head.index('<body>\n') + len('<body>\n')]
open('index.html', 'w').write(head + body + '\n</body>\n</html>\n')
print('index.html', len(head + body))
