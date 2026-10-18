from pathlib import Path
import hashlib,json,re,shutil,os,subprocess,datetime,sys
root=Path(__file__).resolve().parent
out=root/sys.argv[1];out.mkdir(mode=0o700)
w=Path('/Users/mtakemiya/dev/tonswap/tonswap_web/.local/worktrees/order-ledger-recovery/tonswap_web');c=Path('/Users/mtakemiya/dev/tonswap/tonswap_tolk');art=c/'build'
queue=[w/'tests/wire/currentOrderLedgerRecovery.native.test.ts',w/'vitest.config.ts',w/'tests/setup/release.ts',c/'wrappers/utils/spotOrderEconomics.ts'];seen=set()
while queue:
 p=queue.pop().resolve()
 if p in seen or 'node_modules' in p.parts or not p.is_file():continue
 seen.add(p)
 if p.suffix not in ['.ts','.js','.mjs','.vue']:continue
 for rel in re.findall(r"(?:from\s*|import\s*\(|import\s*)['\"](\.[^'\"]+)['\"]",p.read_text()):
  candidate=p.parent/rel
  for possible in [candidate,*[Path(str(candidate)+s) for s in ['.ts','.tsx','.js','.mjs','.json','.vue']],candidate/'index.ts']:
   if possible.is_file():queue.append(possible);break
for repo in [w,c]:
 for f in ['package.json','package-lock.json']:seen.add(repo/f)
m=c/'tests/fixtures/native/transaction-worker-build.json';seen.add(m);manifest=json.loads(m.read_text())
for kind in ['binary','source']:seen.add(m.parent/manifest[kind]['path'])
seen.update(p for p in art.iterdir() if p.is_file())
seen.update(p for p in (c/'contracts/vendor').rglob('*') if p.is_file())
seen.update([c/'config/opcodes.json',c/'config/opcodes.retired.json'])
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
# The current renderer is read-only: retain every exact physical or virtual
# compiler input consumed by the cached targets, including opcode includes.
virtualJson=subprocess.check_output(['/opt/homebrew/opt/node@22/bin/node','-r','ts-node/register/transpile-only','-e',"const fs=require('fs'),b=require('./scripts/build/build');process.stdout.write(JSON.stringify(b.knownSources(JSON.parse(fs.readFileSync('build/manifest.json','utf8')),require('path').resolve('build'))));"],cwd=c,text=True)
virtual=json.loads(virtualJson);built=json.loads((art/'manifest.json').read_text());compilerInputs={}
for target,meta in built['targets'].items():
 for name,expected in meta['inputs'].items():
  data=virtual[name].encode() if name in virtual else (c/name).read_bytes()
  assert hashlib.sha256(data).hexdigest()==expected,(target,name)
  compilerInputs[name]={'sha256':expected,'virtual':name in virtual}
  if name not in virtual:seen.add(c/name)
virtualFiles=[]
for name,meta in sorted(compilerInputs.items()):
 if not meta['virtual']:continue
 target=out/'virtual'/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(virtual[name]);virtualFiles.append({'input':name,'snapshot':str(target.relative_to(out)),'sha256':sha(target)})

files=[]
for p in sorted(seen):
 if not p.is_file():continue
 relative=Path('web')/p.relative_to(w) if p.is_relative_to(w) else Path('contracts')/p.relative_to(c)
 target=out/'source'/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,target)
 files.append({'path':str(p),'snapshot':str(target.relative_to(out)),'bytes':p.stat().st_size,'sha256':sha(p)})
lock={'schema':'order-ledger-source-lock-v1','startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Relative import closure, package locks, current compiled build artifacts and original pinned native worker. Installed npm dependency bytes are not reconstructed from locks. Native sandbox only, not deployment qualification.','files':files,'compilerInputs':compilerInputs,'virtualFiles':virtualFiles}
(out/'source-lock.json').write_text(json.dumps(lock,indent=2)+'\n')
env=os.environ.copy()
for k in list(env):
 if k.startswith('TONSWAP_') or k in ['NODE_OPTIONS','TS_NODE_PROJECT']:del env[k]
env['PATH']='/opt/homebrew/opt/node@22/bin:'+env['PATH'];env['TONSWAP_CONTRACT_BUILD_DIR']=str(art);env['TONSWAP_REQUIRE_WIRE_CONFORMANCE']='1';env['TONSWAP_ORDER_LEDGER_RECOVERY_OUTPUT']=str(out/'captures')
command=['/opt/homebrew/opt/node@22/bin/node','./node_modules/vitest/vitest.mjs','--configLoader','runner','run','tests/wire/currentOrderLedgerRecovery.native.test.ts','--maxWorkers=1','--no-file-parallelism']
print(json.dumps({'startedAt':lock['startedAt'],'command':command,'cwd':str(w),'sourceLockSha256':sha(out/'source-lock.json'),'files':len(files)}),flush=True)
with (out/'native.log').open('x') as log:r=subprocess.run(command,cwd=w,env=env,stdout=log,stderr=subprocess.STDOUT)
changed=[f['path'] for f in files if sha(Path(f['path']))!=f['sha256']]
receipt={'schema':'order-ledger-native-run-v1','command':command,'cwd':str(w),'startedAt':lock['startedAt'],'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':r.returncode,'sourceLockSha256':sha(out/'source-lock.json'),'changedSources':changed,'outputs':[{'path':str(p.relative_to(out)),'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted((out/'captures').glob('*.json'))],'logSha256':sha(out/'native.log')}
(out/'completion.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2));sys.exit(r.returncode or bool(changed))
