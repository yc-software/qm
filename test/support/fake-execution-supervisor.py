import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import base64

request_path = sys.argv[sys.argv.index('--request') + 1]
request = json.loads(pathlib.Path(request_path).read_text())
os.unlink(request_path)
home = tempfile.mkdtemp(prefix='fake-execution-home-')
try:
    for item in request.get('files', []):
        relative = pathlib.PurePosixPath(item['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('invalid credential path')
        target = pathlib.Path(home, *relative.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(item['contentBase64']))
        target.chmod(0o600)
    env = dict(os.environ)
    env.update(request['env'])
    env['HOME'] = home
    env['XDG_CONFIG_HOME'] = home + '/.config'
    command = request['command']
    stream = '--stream' in sys.argv
    try:
        result = subprocess.run(['sh', '-c', command], cwd=request['cwd'], env=env,
            timeout=request['timeoutMs'] / 1000, capture_output=not stream, text=True)
        output = {'code': result.returncode, 'stdout': result.stdout or '', 'stderr': result.stderr or '', 'timedOut': False}
    except subprocess.TimeoutExpired as error:
        output = {'code': 124, 'stdout': '', 'stderr': '', 'timedOut': True}
    if stream:
        sys.exit(output['code'])
    print(json.dumps(output))
finally:
    shutil.rmtree(home)
