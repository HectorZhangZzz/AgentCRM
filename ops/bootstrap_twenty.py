#!/usr/bin/env python3
"""Create a fresh local projection workspace and scoped API key; no external calls."""
import datetime, json, secrets, sys, time, urllib.parse, urllib.request
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import manage

c=manage.config();base=c['twenty']['url']
if urllib.parse.urlsplit(base).hostname not in ('127.0.0.1','localhost','::1'):raise RuntimeError('Local bootstrap only')
statefile=manage.LOCAL/'twenty-access.json'
s=json.loads(statefile.read_text()) if statefile.exists() else {'email':'crm-owner-'+secrets.token_hex(6)+'@example.invalid','password':'Crm!'+secrets.token_urlsafe(32)}
manage.private_json(statefile,s)

def save():manage.private_json(statefile,s)
def gql(query,variables=None,token=None):
    headers={'Content-Type':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    req=urllib.request.Request(base+'/metadata',json.dumps({'query':query,'variables':variables or {}}).encode(),headers,method='POST')
    with urllib.request.urlopen(req,timeout=180) as res:d=json.load(res)
    if d.get('errors'):raise RuntimeError('Twenty GraphQL bootstrap failed: '+json.dumps([{'message':v.get('message')} for v in d['errors']]))
    return d['data']

if not s.get('agnosticToken'):
    d=gql('mutation($email:String!,$password:String!){signUp(email:$email,password:$password){tokens{accessOrWorkspaceAgnosticToken{token}}}}',{'email':s['email'],'password':s['password']})
    s['agnosticToken']=d['signUp']['tokens']['accessOrWorkspaceAgnosticToken']['token'];save()
if not s.get('signup'):
    s['signup']=gql('mutation{signUpInNewWorkspace{loginToken{token} workspace{id workspaceUrls{subdomainUrl customUrl}}}}',token=s['agnosticToken'])['signUpInNewWorkspace'];save()
signup=s['signup']
def refresh():
    d=gql('mutation($loginToken:String!,$origin:String!){getAuthTokensFromLoginToken(loginToken:$loginToken,origin:$origin){tokens{accessOrWorkspaceAgnosticToken{token}}}}',{'loginToken':signup['loginToken']['token'],'origin':signup['workspace']['workspaceUrls']['subdomainUrl']})
    s['token']=d['getAuthTokensFromLoginToken']['tokens']['accessOrWorkspaceAgnosticToken']['token'];save()
refresh()
if not s.get('activated'):
    gql('mutation($input:ActivateWorkspaceInput!){activateWorkspace(data:$input){id displayName activationStatus}}',{'input':{'displayName':'个人 CRM 投影'}},s['token'])
    s['activated']=True;save();refresh()
if not s.get('roleId'):
    role=gql('mutation($input:CreateRoleInput!){createOneRole(createRoleInput:$input){id label}}',{'input':{'label':'Agent CRM Projection','canBeAssignedToApiKeys':True,'canReadAllObjectRecords':True,'canUpdateAllObjectRecords':True,'canSoftDeleteAllObjectRecords':False,'canDestroyAllObjectRecords':False,'canUpdateAllSettings':False,'canAccessAllTools':False}},s['token'])['createOneRole']
    s['roleId']=role['id'];save()
if not s.get('apiKey'):
    expiry=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=365)).strftime('%Y-%m-%dT%H:%M:%SZ')
    key=gql('mutation($input:CreateApiKeyInput!){createApiKey(input:$input){id name role{id label}}}',{'input':{'name':'Agent CRM Projection','roleId':s['roleId'],'expiresAt':expiry}},s['token'])['createApiKey']
    token=gql('mutation($id:UUID!,$expiresAt:String!){generateApiKeyToken(apiKeyId:$id,expiresAt:$expiresAt){token}}',{'id':key['id'],'expiresAt':expiry},s['token'])['generateApiKeyToken']['token']
    s.update(apiKey=token,apiKeyId=key['id'],apiKeyExpiresAt=expiry);save()
c['twenty'].update(apiKey=s['apiKey'],apiKeyId=s['apiKeyId'],workspaceId=signup['workspace']['id'],apiKeyExpiresAt=s['apiKeyExpiresAt'])
manage.private_json(manage.CONFIG,c)
print(json.dumps({'ok':True,'workspaceId':c['twenty']['workspaceId'],'apiKeyExpiresAt':s['apiKeyExpiresAt'],'credentialsFile':'.local/twenty-access.json'},ensure_ascii=False))
