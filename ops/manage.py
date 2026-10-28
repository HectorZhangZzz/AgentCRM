#!/usr/bin/env python3
"""Local-only lifecycle and portable backup. Never imports a previous deployment's .env."""
from pathlib import Path
from contextlib import contextmanager
import fcntl
import argparse, base64, datetime, hashlib, hmac, json, os, secrets, shutil, signal, socket, subprocess, sys, tarfile, tempfile, time, urllib.parse, urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.local'
CONFIG = LOCAL / 'config.json'
RUNTIME = ROOT / 'runtime'
PG_BIN = RUNTIME / 'usr/lib/postgresql/16/bin'
VERSION = json.loads((ROOT/'package.json').read_text()).get('version','unknown')

def private_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n')
    path.chmod(0o600)

@contextmanager
def maintenance(blocking=True):
    """Serialize stop/write-free exports with the optional user supervisor."""
    LOCAL.mkdir(parents=True,exist_ok=True)
    lock_path=LOCAL/'maintenance.lock'
    with lock_path.open('a') as lock:
        lock_path.chmod(0o600)
        acquired=False
        try:
            try:
                fcntl.flock(lock,fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
                acquired=True
            except BlockingIOError:
                pass
            yield acquired
        finally:
            if acquired:fcntl.flock(lock,fcntl.LOCK_UN)

def config():
    if not CONFIG.exists(): raise RuntimeError('先运行 ./ops/crm init')
    return json.loads(CONFIG.read_text())

def base_env():
    env={k:os.environ[k] for k in ('PATH','HOME','LANG','LC_ALL','TZ') if k in os.environ}
    env['LD_LIBRARY_PATH']=str(RUNTIME/'usr/lib/x86_64-linux-gnu')
    return env

def pg_env(c):
    env=base_env(); env.update(PGPASSWORD=c['postgres']['password'], PGHOST='127.0.0.1', PGPORT=str(c['postgres']['port']), PGUSER=c['postgres']['user'])
    return env

def pg(c, sql, database='postgres', tuples=True):
    args=[str(PG_BIN/'psql'),'-X','-v','ON_ERROR_STOP=1','-d',database]
    if tuples: args+=['-A','-t']
    p=subprocess.run(args+['-c',sql],env=pg_env(c),capture_output=True,text=True)
    if p.returncode: raise RuntimeError('PostgreSQL 操作失败: '+p.stderr[-1500:])
    return p.stdout.strip()

def running(pidfile):
    try:
        pid=int(pidfile.read_text()); os.kill(pid,0)
        fields=Path('/proc',str(pid),'stat').read_text().split()
        if fields[2]=='Z':return False
        identity=pidfile.with_suffix('.identity.json')
        if identity.exists():
            expected=json.loads(identity.read_text())
            return expected.get('pid')==pid and expected.get('startTicks')==fields[21]
        # Older PID files are accepted only when the expected local process
        # still owns them; a recycled PID must never target another application.
        cmd=Path('/proc',str(pid),'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace')
        if pidfile.stem=='redis':
            c=json.loads(CONFIG.read_text())
            return 'redis-server' in cmd and ('127.0.0.1:'+str(c['redis']['port'])) in cmd
        expected={'app':'src/server.mjs','twenty-api':'dist/main.js','twenty-worker':'dist/queue-worker/queue-worker.js'}.get(pidfile.stem)
        return bool(expected and expected in cmd and Path('/proc',str(pid),'cwd').resolve().is_relative_to(ROOT))
    except (ValueError,FileNotFoundError,ProcessLookupError,PermissionError): return False

def record_identity(pidfile):
    pid=int(pidfile.read_text())
    fields=Path('/proc',str(pid),'stat').read_text().split()
    private_json(pidfile.with_suffix('.identity.json'),{'pid':pid,'startTicks':fields[21]})

def wait_port(port, timeout=40):
    end=time.time()+timeout
    while time.time()<end:
        try:
            with socket.create_connection(('127.0.0.1',port),timeout=.5): return True
        except OSError: time.sleep(.25)
    return False

def ensure_runtime():
    if not (PG_BIN/'initdb').exists(): raise RuntimeError('缺少 PostgreSQL 16 本机运行时；参阅 docs/INSTALL.md')
    if not (RUNTIME/'usr/bin/redis-server').exists(): raise RuntimeError('缺少 Redis 本机运行时；参阅 docs/INSTALL.md')

def create_config(args):
    if CONFIG.exists():
        c=config();write_client_configs(c);return c
    check_ports(args)
    LOCAL.mkdir(parents=True,exist_ok=True); LOCAL.chmod(0o700)
    password=secrets.token_urlsafe(36); redis_password=secrets.token_urlsafe(32)
    c={'version':1,'port':args.port,'dataDir':str(LOCAL/'data'),
       'databaseUrl':f'postgresql://crm_owner:{password}@127.0.0.1:{args.pg_port}/portable_crm',
       'ownerToken':secrets.token_urlsafe(48),'writerToken':secrets.token_urlsafe(48),'readerToken':secrets.token_urlsafe(48),
       'postgres':{'port':args.pg_port,'user':'crm_owner','password':password,'dataDir':str(LOCAL/'postgres')},
       'redis':{'port':args.redis_port,'password':redis_password},
       'twenty':{'url':f'http://127.0.0.1:{args.twenty_port}','port':args.twenty_port,
                 'databaseUrl':f'postgresql://crm_owner:{password}@127.0.0.1:{args.pg_port}/twenty_crm',
                 'appSecret':secrets.token_urlsafe(48),'enabled':True,'appVersion':'2.1.0'}}
    private_json(CONFIG,c)
    write_client_configs(c)
    return c

def write_client_configs(c):
    for role in ('reader','writer'):
        private_json(LOCAL/(role+'-client.json'),{'version':1,'url':f"http://127.0.0.1:{c['port']}",'token':c[role+'Token'],'role':role})

def check_ports(args):
    ports=[args.pg_port,args.redis_port,args.port,args.twenty_port]
    if len(set(ports))!=len(ports) or any(p<1024 or p>65535 for p in ports):raise RuntimeError('端口必须互不相同且在1024..65535之间')
    for port in ports:
        try:
            with socket.socket() as sock:sock.bind(('127.0.0.1',port))
        except OSError:raise RuntimeError('目标端口已占用: '+str(port))

def infra_start(c):
    ensure_runtime()
    for name in ('logs','pids','data','redis','twenty-storage','twenty-work'):
        (LOCAL/name).mkdir(parents=True,exist_ok=True)
    pgdata=LOCAL/'postgres'
    if not (pgdata/'PG_VERSION').exists():
        if pgdata.exists() and any(pgdata.iterdir()): raise RuntimeError('拒绝初始化非空 PostgreSQL 目录')
        with tempfile.NamedTemporaryFile(dir=LOCAL,mode='w',delete=False) as f:
            f.write(c['postgres']['password']+'\n'); passfile=Path(f.name)
        passfile.chmod(0o600)
        try:
            subprocess.run([str(PG_BIN/'initdb'),'-D',str(pgdata),'-L',str(RUNTIME/'usr/share/postgresql/16'),'--username='+c['postgres']['user'],'--pwfile='+str(passfile),'--auth-local=scram-sha-256','--auth-host=scram-sha-256','--encoding=UTF8','--locale=C.UTF-8'],env=base_env(),check=True,stdout=subprocess.DEVNULL)
        finally: passfile.unlink(missing_ok=True)
        with (pgdata/'postgresql.conf').open('a') as f:
            f.write("\nlisten_addresses = '127.0.0.1'\nport = %s\nunix_socket_directories = ''\nssl = off\n"%c['postgres']['port'])
    status=subprocess.run([str(PG_BIN/'pg_ctl'),'-D',str(pgdata),'status'],env=base_env(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if status.returncode:
        subprocess.run([str(PG_BIN/'pg_ctl'),'-D',str(pgdata),'-l',str(LOCAL/'logs/postgresql.log'),'-w','start'],env=base_env(),check=True,stdout=subprocess.DEVNULL)
    redis_pid=LOCAL/'pids/redis.pid'
    if not running(redis_pid):
        redis_conf=LOCAL/'redis.conf'
        redis_conf.write_text('\n'.join(['bind 127.0.0.1',f"port {c['redis']['port']}",'protected-mode yes',f"requirepass {c['redis']['password']}",f'dir {LOCAL/"redis"}','dbfilename dump.rdb','appendonly yes',f'pidfile {redis_pid}',f'logfile {LOCAL/"logs/redis.log"}','daemonize yes'])+'\n')
        redis_conf.chmod(0o600)
        subprocess.run([str(RUNTIME/'usr/bin/redis-server'),str(redis_conf)],env=base_env(),check=True)
        if not wait_port(c['redis']['port'],10):raise RuntimeError('Redis未能启动')
    record_identity(redis_pid)
    for db in ('portable_crm','twenty_crm'):
        if not pg(c,"SELECT 1 FROM pg_database WHERE datname='%s'"%db):
            subprocess.run([str(PG_BIN/'createdb'),db],env=pg_env(c),check=True)

def twenty_env(c):
    env=base_env(); t=c['twenty']; r=c['redis']
    env.update({'NODE_ENV':'production','PG_DATABASE_URL':t['databaseUrl'],
    'REDIS_URL':f"redis://:{r['password']}@127.0.0.1:{r['port']}",'APP_SECRET':t['appSecret'],
    'SERVER_URL':t['url'],'FRONTEND_URL':t['url'],'NODE_PORT':str(t['port']),'APP_VERSION':t.get('appVersion','2.1.0'),
    'IS_CONFIG_VARIABLES_IN_DB_ENABLED':'false','AI_PROVIDERS':'{}','AI_MODEL_PREFERENCES':'{}',
    'IS_BILLING_ENABLED':'false','IS_EMAIL_VERIFICATION_REQUIRED':'false','IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS':'false',
    'AUTH_PASSWORD_ENABLED':'true','SIGN_IN_PREFILLED':'false','EMAIL_DRIVER':'LOGGER','STORAGE_TYPE':'local',
    'STORAGE_LOCAL_PATH':str(LOCAL/'twenty-storage'),'CODE_INTERPRETER_TYPE':'DISABLED','LOGIC_FUNCTION_TYPE':'DISABLED',
    'TELEMETRY_ENABLED':'false','ANALYTICS_ENABLED':'false','EXCEPTION_HANDLER_DRIVER':'CONSOLE',
    'ALLOW_REQUESTS_TO_TWENTY_ICONS':'false','DISABLE_CRON_JOBS_REGISTRATION':'true','PG_POOL_ALLOW_EXIT_ON_IDLE':'true',
    'NX_DAEMON':'false','NX_NO_CLOUD':'true','YARN_ENABLE_TELEMETRY':'0',
    'CRM_LAB_NETWORK_LOG':str(LOCAL/'logs/network-audit.jsonl'),
    'NODE_OPTIONS':'--require '+str(ROOT/'ops/loopback-only.cjs')})
    return env

def twenty_work():
    work=LOCAL/'twenty-work';work.mkdir(parents=True,exist_ok=True)
    # TypeORM discovers the nearest package.json lexically through dist symlinks.
    # Parent capability package is ESM; upstream SWC output is CommonJS.
    (work/'package.json').write_text('{"private":true,"type":"commonjs"}\n')
    for name,target in [('dist',ROOT/'vendor/twenty/packages/twenty-server/dist'),('node_modules',ROOT/'vendor/twenty/node_modules')]:
        path=work/name
        if not path.is_symlink() and path.exists(): raise RuntimeError('Twenty运行目录存在非托管文件: '+name)
        if path.is_symlink(): path.unlink()
        path.symlink_to(os.path.relpath(target,work),target_is_directory=True)
    return work

def twenty_init(c):
    if not c['twenty'].get('enabled',True): return
    marker=LOCAL/'twenty-initialized.json'
    if marker.exists() and pg(c,"SELECT to_regclass('core.user') IS NOT NULL",'twenty_crm')=='t': return
    if not (ROOT/'vendor/twenty/packages/twenty-server/dist/main.js').exists():
        raise RuntimeError('Twenty编译产物缺失；运行 ops/build-twenty.sh')
    work=twenty_work()
    with (LOCAL/'logs/twenty-init.log').open('a') as log:
        for args in [('dist/database/scripts/setup-db.js',),('dist/command/command.js','run-instance-commands','--force','--include-slow')]:
            subprocess.run(['node',*args],cwd=work,env=twenty_env(c),stdout=log,stderr=subprocess.STDOUT,check=True,timeout=600)
    if pg(c,"SELECT to_regclass('core.user') IS NOT NULL",'twenty_crm')!='t':
        raise RuntimeError('Twenty迁移未产生core.user；检查 .local/logs/twenty-init.log')
    private_json(marker,{'appVersion':c['twenty'].get('appVersion'),'initializedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})

def daemon(name,args,cwd,env):
    pidfile=LOCAL/'pids'/(name+'.pid')
    if running(pidfile): return
    with (LOCAL/'logs'/(name+'.log')).open('ab') as log:
        p=subprocess.Popen(args,cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    pidfile.write_text(str(p.pid)+'\n');pidfile.chmod(0o600)
    record_identity(pidfile)

def stop_apps():
    for name in ('app','twenty-worker','twenty-api'):
        path=LOCAL/'pids'/(name+'.pid')
        if running(path):
            pid=int(path.read_text());os.kill(pid,signal.SIGTERM)
            for _ in range(40):
                if not running(path): break
                time.sleep(.25)
            if running(path): os.kill(pid,signal.SIGKILL)
        path.unlink(missing_ok=True)
        path.with_suffix('.identity.json').unlink(missing_ok=True)

def start(c):
    infra_start(c);twenty_init(c)
    env=base_env();env['CRM_CONFIG']=str(CONFIG)
    daemon('app',['node','src/server.mjs'],ROOT,env)
    if c['twenty'].get('enabled',True):
        work=twenty_work();env=twenty_env(c)
        daemon('twenty-api',['node','dist/main.js'],work,env)
        daemon('twenty-worker',['node','dist/queue-worker/queue-worker.js'],work,env)
    if not wait_port(c['port'],60):raise RuntimeError('能力服务启动失败，查看 .local/logs/app.log')
    if c['twenty'].get('enabled',True) and not wait_port(c['twenty']['port'],120):
        raise RuntimeError('Twenty API启动未就绪，查看 .local/logs/twenty-api.log；领域数据仍保留')
    print('管理台 http://127.0.0.1:%s ；访问凭据保存在 .local/config.json（私有）'%c['port'])

def stop(c):
    stop_apps()
    if (LOCAL/'postgres/PG_VERSION').exists():
        subprocess.run([str(PG_BIN/'pg_ctl'),'-D',str(LOCAL/'postgres'),'-m','fast','-w','stop'],env=base_env(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    path=LOCAL/'pids/redis.pid'
    if running(path):
        os.kill(int(path.read_text()),signal.SIGTERM)
        for _ in range(40):
            if not running(path):break
            time.sleep(.25)
        if running(path):raise RuntimeError('Redis尚未退出，请检查日志后重试，未强行删除数据')

def status(c):
    services={name:running(LOCAL/'pids'/(name+'.pid')) for name in ('app','twenty-api','twenty-worker','redis')}
    services['postgres']=subprocess.run([str(PG_BIN/'pg_ctl'),'-D',str(LOCAL/'postgres'),'status'],env=base_env(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
    print(json.dumps({'services':services,'managementUrl':f"http://127.0.0.1:{c['port']}",'twentyUrl':c['twenty']['url'],'configFile':'.local/config.json'},ensure_ascii=False,indent=2))

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        while chunk:=f.read(1024*1024):h.update(chunk)
    return h.hexdigest()

def projection_rekey(c, projection=None, renew=False):
    """Re-sign the existing scoped key under the new local secret after restore.

    Does not create/expand a role and never copies an old bearer token.
    Same JWT format as audited upstream ApiKeyService/JwtWrapperService.
    """
    projection=projection or c['twenty']
    key_id=projection.get('apiKeyId')
    if not key_id:return
    import uuid
    key_id=str(uuid.UUID(key_id))
    if renew:
        pg(c,"UPDATE core.\"apiKey\" SET \"expiresAt\"=NOW()+INTERVAL '365 days' WHERE id='%s' AND \"revokedAt\" IS NULL"%key_id,'twenty_crm')
    row=pg(c,"SELECT row_to_json(t) FROM (SELECT id,\"workspaceId\",\"expiresAt\",\"revokedAt\" FROM core.\"apiKey\" WHERE id='%s') t"%key_id,'twenty_crm')
    if not row:raise RuntimeError('恢复库缺少原投影APIkey记录')
    row=json.loads(row)
    if row['revokedAt']:raise RuntimeError('投影key已撤销，不能重新签发')
    exp=int(datetime.datetime.fromisoformat(row['expiresAt'].replace('Z','+00:00')).timestamp())
    if exp<=time.time():raise RuntimeError('投影key过期；在目标目录运行 ./ops/crm renew-projection-key')
    payload={'sub':row['workspaceId'],'type':'API_KEY','workspaceId':row['workspaceId'],'jti':key_id,'iat':int(time.time()),'exp':exp}
    b64=lambda b:base64.urlsafe_b64encode(b).rstrip(b'=').decode()
    signing_input='.'.join([b64(json.dumps({'alg':'HS256','typ':'JWT'},separators=(',',':')).encode()),b64(json.dumps(payload,separators=(',',':')).encode())])
    secret=hashlib.sha256((c['twenty']['appSecret']+row['workspaceId']+'API_KEY').encode()).hexdigest()
    token=signing_input+'.'+b64(hmac.new(secret.encode(),signing_input.encode(),hashlib.sha256).digest())
    c['twenty'].update(apiKey=token,apiKeyId=key_id,workspaceId=row['workspaceId'],apiKeyExpiresAt=row['expiresAt'])
    private_json(CONFIG,c)

def fingerprint(c,database):
    tables=pg(c,"SELECT json_agg(json_build_array(schemaname,tablename) ORDER BY schemaname,tablename) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')",database)
    result={}
    for schema,table in json.loads(tables or '[]') or []:
        ident='"'+schema.replace('"','""')+'"."'+table.replace('"','""')+'"'
        result[schema+'.'+table]=pg(c,"SELECT json_build_object('rows',count(*),'hash',md5(coalesce(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),''))) FROM "+ident+' t',database)
    return result

def backup_inner(c,args):
    infra_start(c)
    resume=running(LOCAL/'pids/app.pid')
    stop_apps()
    out=Path(args.out or ROOT/'backups');out.mkdir(parents=True,exist_ok=True);out.chmod(0o700)
    stamp=time.strftime('%Y%m%d-%H%M%S')+'-'+secrets.token_hex(3)
    bundle=out/('agent-crm-'+stamp+'.tar.gz')
    try:
        with tempfile.TemporaryDirectory(prefix='crm-backup-',dir=LOCAL) as td:
            stage=Path(td);(stage/'databases').mkdir()
            fingerprints={}
            for db in ('portable_crm','twenty_crm'):
                subprocess.run([str(PG_BIN/'pg_dump'),'-Fc','--no-owner','--no-acl','-d',db,'-f',str(stage/'databases'/(db+'.dump'))],env=pg_env(c),check=True)
                fingerprints[db]=fingerprint(c,db)
            for source,target in [(Path(c['dataDir']),stage/'data'),(LOCAL/'twenty-storage',stage/'twenty-storage')]:
                if source.exists():shutil.copytree(source,target)
                else:target.mkdir()
            # Preserve the upstream application secret for any signed/encrypted
            # upstream data. This private backup member contains no bearer token.
            private_json(stage/'private-secrets.json',{'twentyAppSecret':c['twenty']['appSecret']})
            manifest={'format':'portable-crm-backup-v1','appVersion':VERSION,'contractVersion':1,'postgresMajor':16,'twentyVersion':c['twenty'].get('appVersion'),'projection':{k:c['twenty'][k] for k in ('workspaceId','apiKeyId') if k in c['twenty']},'createdAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'fingerprints':fingerprints,'files':{}}
            for p in sorted(stage.rglob('*')):
                if p.is_file():manifest['files'][p.relative_to(stage).as_posix()]={'sha256':digest(p),'bytes':p.stat().st_size}
            (stage/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
            with tarfile.open(bundle,'w:gz') as tar:
                for p in stage.iterdir():tar.add(p,arcname=p.name)
        bundle.chmod(0o600)
        (out/(bundle.name+'.sha256')).write_text(digest(bundle)+'  '+bundle.name+'\n')
        print(json.dumps({'bundle':str(bundle),'sha256':digest(bundle),'files':len(manifest['files'])},ensure_ascii=False))
    finally:
        if resume:start(c)

def extract_verified(bundle,stage):
    with tarfile.open(bundle,'r:gz') as tar:
        for member in tar.getmembers():
            p=Path(member.name)
            if p.is_absolute() or '..' in p.parts or member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                raise RuntimeError('拒绝不安全备份成员')
        tar.extractall(stage,filter='data')
    manifest=json.loads((stage/'manifest.json').read_text())
    if manifest.get('format')!='portable-crm-backup-v1':raise RuntimeError('备份格式不支持')
    expected=set(manifest['files']);actual={p.relative_to(stage).as_posix() for p in stage.rglob('*') if p.is_file()}-{'manifest.json'}
    if expected!=actual:raise RuntimeError('备份成员清单不一致')
    for rel,info in manifest['files'].items():
        p=stage/rel
        if p.stat().st_size!=info['bytes'] or digest(p)!=info['sha256']:raise RuntimeError('备份文件损坏: '+rel)
    return manifest

def verify(args):
    with tempfile.TemporaryDirectory(prefix='crm-verify-') as td:
        m=extract_verified(Path(args.bundle).resolve(),Path(td))
        print(json.dumps({'ok':True,'format':m['format'],'files':len(m['files']),'createdAt':m['createdAt']},ensure_ascii=False))

def copy_project(target, include_runtime=True):
    target.mkdir(parents=True)
    exclude={'.local','backups','exports','share','.git','node_modules','runtime','vendor','__pycache__'}
    for p in ROOT.iterdir():
        if p.name in exclude:continue
        if p.is_dir():shutil.copytree(p,target/p.name,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
        else:shutil.copy2(p,target/p.name)
    if include_runtime:shutil.copytree(RUNTIME,target/'runtime',symlinks=True,copy_function=shutil.copy2)
    shutil.copytree(ROOT/'vendor',target/'vendor',symlinks=True,copy_function=shutil.copy2)
    # The restore target is independently runnable on this machine, with no link to the old path.
    if (ROOT/'node_modules').exists():shutil.copytree(ROOT/'node_modules',target/'node_modules',symlinks=True)

def restore(args):
    bundle=Path(args.bundle).resolve();target=Path(args.target).expanduser().resolve()
    if target==ROOT or target.is_relative_to(ROOT) or ROOT.is_relative_to(target):raise RuntimeError('恢复目标必须位于当前项目目录之外，且不能是项目祖先目录')
    check_ports(args)
    if target.exists() and any(target.iterdir()):raise RuntimeError('恢复目标必须是全新空目录')
    if target.exists():target.rmdir()
    with tempfile.TemporaryDirectory(prefix='crm-restore-') as td:
        stage=Path(td);manifest=extract_verified(bundle,stage)
        copy_project(target)
        cmd=[sys.executable,str(target/'ops/manage.py'),'init','--skip-twenty-init','--pg-port',str(args.pg_port),'--redis-port',str(args.redis_port),'--port',str(args.port),'--twenty-port',str(args.twenty_port)]
        subprocess.run(cmd,check=True,stdout=subprocess.DEVNULL)
        target_config=json.loads((target/'.local/config.json').read_text())
        secretfile=stage/'private-secrets.json'
        if secretfile.exists():
            target_config['twenty']['appSecret']=json.loads(secretfile.read_text())['twentyAppSecret']
            private_json(target/'.local/config.json',target_config)
        env=base_env();env['LD_LIBRARY_PATH']=str(target/'runtime/usr/lib/x86_64-linux-gnu');env['PGPASSWORD']=target_config['postgres']['password'];env['PGHOST']='127.0.0.1';env['PGPORT']=str(args.pg_port);env['PGUSER']=target_config['postgres']['user']
        for db in ('portable_crm','twenty_crm'):
            subprocess.run([str(target/'runtime/usr/lib/postgresql/16/bin/pg_restore'),'--exit-on-error','--no-owner','--no-acl','-d',db,str(stage/'databases'/(db+'.dump'))],env=env,check=True,stdout=subprocess.DEVNULL)
        for name in ('data','twenty-storage'):
            shutil.copytree(stage/name,target/'.local'/name,dirs_exist_ok=True)
        private_json(target/'.local/twenty-initialized.json',{'appVersion':manifest.get('twentyVersion'),'restoredAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})
        # Separate child process evaluates restored table contents against the original snapshot.
        expected=target/'.local/expected-fingerprints.json';private_json(expected,manifest['fingerprints'])
        subprocess.run([sys.executable,str(target/'ops/manage.py'),'verify-restored'],check=True)
        if manifest.get('projection',{}).get('apiKeyId'):
            private_json(target/'.local/projection-restore.json',manifest['projection'])
            subprocess.run([sys.executable,str(target/'ops/manage.py'),'rekey-restored'],check=True,stdout=subprocess.DEVNULL)
        private_json(target/'.local/restore-report.json',{'ok':True,'bundleSha256':digest(bundle),'files':len(manifest['files']),'databaseFingerprintsMatched':True})
        print(json.dumps({'ok':True,'target':str(target),'managementUrl':f'http://127.0.0.1:{args.port}','next':'./ops/crm start（在目标目录）'},ensure_ascii=False))

def export_inner(c,args):
    out=Path(args.out or ROOT/'exports'/time.strftime('%Y%m%d-%H%M%S')).resolve()
    if out==ROOT or ROOT.is_relative_to(out) or (out.is_relative_to(ROOT) and not out.is_relative_to(ROOT/'exports')):
        raise RuntimeError('导出目标必须位于项目外，或项目的 exports 目录内')
    if out.exists() and any(out.iterdir()):raise RuntimeError('导出目标必须为空')
    out.mkdir(parents=True,exist_ok=True);out.chmod(0o700)
    infra_start(c)
    tables=json.loads(pg(c,"SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='portable_crm'",'portable_crm') or '[]') or []
    data=out/'records';data.mkdir()
    for table in tables:
        ident='"portable_crm"."'+table.replace('"','""')+'"'
        lines=pg(c,'SELECT row_to_json(t)::text FROM '+ident+' t ORDER BY row_to_json(t)::text','portable_crm')
        (data/(table+'.jsonl')).write_text(lines+'\n' if lines else '')
    shutil.copytree(Path(c['dataDir']),out/'originals',dirs_exist_ok=True)
    source=out/'source';source.mkdir()
    for name in ('src','migrations','public','skills','docs','ops','test','examples','integrations','deploy','package.json','package-lock.json','README.md','AGENTS.md'):
        p=ROOT/name
        if p.is_dir():shutil.copytree(p,source/name,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
        elif p.is_file():shutil.copy2(p,source/name)
    # Include sanitized upstream source, omit generated code and dependency trees.
    shutil.copytree(ROOT/'vendor/twenty',source/'vendor/twenty',symlinks=False,ignore=shutil.ignore_patterns('node_modules','dist','.yarn/cache','.env*','__pycache__'))
    manifest={'format':'portable-crm-readable-export-v1','version':VERSION,'tables':tables,'files':{}}
    for p in sorted(out.rglob('*')):
        if p.is_file():manifest['files'][p.relative_to(out).as_posix()]=digest(p)
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'ok':True,'directory':str(out),'tables':len(tables),'files':len(manifest['files'])},ensure_ascii=False))

def backup(c,args):
    with maintenance():return backup_inner(c,args)

def export(c,args):
    with maintenance():return export_locked(c,args)

def export_locked(c,args):
    infra_start(c)
    resume=running(LOCAL/'pids/app.pid')
    stop_apps()
    try:export_inner(c,args)
    finally:
        if resume:start(c)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    for name in ('init','restore'):
        p=sub.add_parser(name)
        p.add_argument('--pg-port',type=int,default=55433 if name=='init' else 55434)
        p.add_argument('--redis-port',type=int,default=56380 if name=='init' else 56381)
        p.add_argument('--port',type=int,default=4310 if name=='init' else 4320)
        p.add_argument('--twenty-port',type=int,default=4311 if name=='init' else 4321)
        if name=='init':p.add_argument('--skip-twenty-init',action='store_true')
        else:p.add_argument('bundle');p.add_argument('--target',required=True)
    for name in ('start','stop','status','verify-restored','open','login-url','rekey-restored','renew-projection-key'):sub.add_parser(name)
    p=sub.add_parser('connection');p.add_argument('--reader',action='store_true')
    p.add_argument('--host',choices=['generic','workbuddy','codex','dots','hermes','openclaw'],default='generic')
    p.add_argument('--wsl');p.add_argument('--project-root');p.add_argument('--node')
    p=sub.add_parser('share');p.add_argument('--out')
    for name in ('backup','export'):
        p=sub.add_parser(name);p.add_argument('--out')
    p=sub.add_parser('verify');p.add_argument('bundle')
    args=parser.parse_args()
    if args.command=='verify':verify(args);return
    if args.command=='share':
        from share_package import create_share
        out=Path(args.out) if args.out else ROOT/'share'/('agent-crm-'+VERSION+'-source-'+time.strftime('%Y%m%d-%H%M%S')+'.zip')
        print(json.dumps(create_share(ROOT,out),ensure_ascii=False));return
    if args.command=='restore':restore(args);return
    if args.command in ('open','login-url','connection'):
        command=['node',str(ROOT/'src/cli.mjs'),args.command]
        if args.command=='connection':
            if args.reader:command.append('--reader')
            command+=['--host',args.host]
            for name in ('wsl','project_root','node'):
                if getattr(args,name):command+=['--'+name.replace('_','-'),getattr(args,name)]
        subprocess.run(command,cwd=ROOT,check=True);return
    if args.command=='init':
        c=create_config(args);infra_start(c)
        if not args.skip_twenty_init:twenty_init(c)
        print('本机隔离配置已就绪；配置和令牌仅保存在 .local/config.json');return
    c=config()
    if args.command=='start':start(c)
    elif args.command=='stop':stop(c);print('本项目服务已停止')
    elif args.command=='status':status(c)
    elif args.command=='backup':backup(c,args)
    elif args.command=='export':export(c,args)
    elif args.command in ('rekey-restored','renew-projection-key'):
        projection=json.loads((LOCAL/'projection-restore.json').read_text()) if args.command=='rekey-restored' else None
        projection_rekey(c,projection,renew=args.command=='renew-projection-key')
        print('原投影角色的本机API密钥已重新签发；重启能力服务使其生效')
    elif args.command=='verify-restored':
        expected=json.loads((LOCAL/'expected-fingerprints.json').read_text())
        actual={db:fingerprint(c,db) for db in expected}
        if actual!=expected:raise RuntimeError('恢复数据库与备份表内容指纹不一致')
        print(json.dumps({'ok':True,'databases':{db:len(v) for db,v in actual.items()},'tableFingerprintsMatched':True},ensure_ascii=False))

if __name__=='__main__':
    try:main()
    except (RuntimeError,subprocess.SubprocessError,OSError,ValueError,KeyError) as e:
        print('操作失败: '+str(e),file=sys.stderr);sys.exit(1)
