#!/usr/bin/env python3
"""Install this checkout as a local, login-scoped systemd user service."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import manage

port=manage.config()['port']
unit_name = 'agent-crm.service' if port==4310 else f'agent-crm-{port}.service'
unit_dir = Path.home() / '.config/systemd/user'
unit_path = unit_dir / unit_name
node = shutil.which('node')
if not node:
    raise SystemExit('需要可用的 Node 24')
subprocess.run(['systemctl','--user','is-system-running'],check=True,stdout=subprocess.DEVNULL)
if any(x in str(manage.ROOT) for x in ('\n','%','"')):
    raise SystemExit('此路径不能写入 systemd 单元，请移动项目目录后重试')
path_value = ':'.join(dict.fromkeys([str(Path(node).parent),'/usr/local/bin','/usr/bin','/bin']))
contents = f'''[Unit]
Description=Agent CRM (loopback only)
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=notify
NotifyAccess=main
WorkingDirectory={manage.ROOT}
ExecStart=/usr/bin/python3 "{manage.ROOT}/ops/supervise.py"
Environment="PATH={path_value}"
UMask=0077
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStartSec=180
TimeoutStopSec=180

[Install]
WantedBy=default.target
'''
if unit_path.exists() and f'WorkingDirectory={manage.ROOT}\n' not in unit_path.read_text():
    raise SystemExit('已有同名服务属于其他项目，未覆盖')
if unit_path.exists():
    subprocess.run(['systemctl','--user','stop',unit_name],check=True)
manage.stop(manage.config())
unit_dir.mkdir(parents=True,exist_ok=True)
unit_path.write_text(contents)
unit_path.chmod(0o600)
manage.private_json(manage.LOCAL/'user-service.json',{'unit':unit_name,'projectRoot':str(manage.ROOT),'unitPath':str(unit_path)})
subprocess.run(['systemctl','--user','daemon-reload'],check=True)
subprocess.run(['systemctl','--user','enable','--now',unit_name],check=True)
print('已安装并启动当前用户的 CRM 服务；登录后自动启动，仅监听本机。')
