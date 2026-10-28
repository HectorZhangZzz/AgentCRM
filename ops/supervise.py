#!/usr/bin/env python3
"""User-service supervisor. Shared maintenance lock prevents restart during backup."""
from pathlib import Path
import fcntl
import json
import os
import signal
import socket
import threading
import urllib.request
import manage

stopping = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: stopping.set())
signal.signal(signal.SIGINT, lambda *_: stopping.set())

def notify(message):
    address = os.environ.get('NOTIFY_SOCKET')
    if not address:
        return
    if address.startswith('@'):
        address = '\0' + address[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as client:
        client.connect(address)
        client.sendall(message.encode())

def healthy(config):
    ports = [config['port']]
    if config['twenty'].get('enabled', True):
        ports.append(config['twenty']['port'])
    try:
        for port in ports:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz', timeout=4) as response:
                if response.status != 200:
                    return False
        expected = ['app', 'redis'] + (['twenty-api','twenty-worker'] if config['twenty'].get('enabled',True) else [])
        return all(manage.running(manage.LOCAL / 'pids' / (name + '.pid')) for name in expected)
    except Exception:
        return False

try:
    config = manage.config()
    with manage.maintenance():
        manage.start(config)
    if not healthy(config):
        raise RuntimeError('服务启动后健康检查未通过')
    notify('READY=1\nSTATUS=Agent CRM healthy; listening on loopback')
    print(json.dumps({'event':'supervisor_ready','port':config['port']}), flush=True)
    failures = 0
    while not stopping.wait(10):
        with manage.maintenance(blocking=False) as acquired:
            if not acquired:
                failures = 0
                continue
            failures = 0 if healthy(config) else failures + 1
            if failures >= 2:
                notify('STATUS=Recovering Agent CRM services')
                manage.stop_apps()
                manage.start(config)
                failures = 0
                notify('STATUS=Agent CRM recovered')
                print(json.dumps({'event':'supervisor_recovered'}), flush=True)
finally:
    notify('STOPPING=1\nSTATUS=Stopping Agent CRM')
    with manage.maintenance():
        manage.stop(manage.config())
