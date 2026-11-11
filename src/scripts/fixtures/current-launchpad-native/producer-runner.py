from pathlib import Path
import hashlib,json,re,shutil,os,subprocess,datetime,sys
base=Path('/Users/mtakemiya/dev/tonswap/.work/fresh-consumer-20261014')
out=Path('/Users/mtakemiya/dev/tonswap/tonswap_web/.local/fresh-consumer-20261018/launchpad-ledger-native-v2')
w=base/'tonswap_web'; c=base/'tonswap_tolk'
art=Path('/Users/mtakemiya/dev/tonswap/ton-indexer/.local/fresh-consumer-20261018/capture-build/current-440/artifacts')
queue=[w/'tests/wire/currentLaunchpad.test.ts',w/'tests/wire/launchpadRecovery.wire.test.ts',w/'vitest.config.ts',w/'tests/setup/release.ts']
seen=set()
while queue:
 p=queue.pop().resolve()
 if p in seen or 'node_modules' in p.parts or not p.is_file(): continue
 seen.add(p)
 if p.suffix not in ['.ts','.js','.mjs','.vue']: continue
 for rel in re.findall(r'''(?:from\s*|import\s*\(|import\s*)['"](\.[^'"]+)['"]''',p.read_text()):
  candidate=p.parent/rel
  for possible in [candidate,*[Path(str(candidate)+suffix) for suffix in ['.ts','.tsx','.js','.mjs','.json','.vue']],candidate/'index.ts']:
   if possible.is_file(): queue.append(possible);break
for root in [w,c]:
 for f in ['package.json','package-lock.json']: seen.add(root/f)
m=c/'tests/fixtures/native/transaction-worker-build.json'; seen.add(m)
manifest=json.loads(m.read_text())
for kind in ['binary','source']: seen.add(m.parent/manifest[kind]['path'])
seen.update(art.glob('*'))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
files=[]
for p in sorted(seen):
 if not p.is_file(): continue
 relative=p.relative_to(base) if p.is_relative_to(base) else Path('retained-build')/p.name
 target=out/'source'/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,target)
 files.append({'path':str(p),'snapshot':str(target.relative_to(out)),'bytes':p.stat().st_size,'sha256':sha(p)})
lock={'schema':'launchpad-ledger-source-lock-v1','startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Relative TypeScript import closure, package locks, retained compiled build artifacts and pinned native worker. Installed npm dependency bytes are not reconstructed from package locks. Native sandbox evidence, not deployment qualification.','files':files}
(out/'source-lock.json').write_text(json.dumps(lock,indent=2)+'\n')
env=os.environ.copy();env['PATH']='/opt/homebrew/opt/node@22/bin:'+env['PATH'];env['TONSWAP_CONTRACT_BUILD_DIR']=str(art);env['TONSWAP_REQUIRE_WIRE_CONFORMANCE']='1';env['TONSWAP_LAUNCHPAD_CAPTURE_DIR']=str(out/'captures');env['TONSWAP_LAUNCHPAD_COMPLETE_DIR']=str(out/'complete');env['TONSWAP_LAUNCHPAD_RECOVERY_COMPLETE_DIR']=str(out/'refund')
command=['./node_modules/.bin/vitest','--configLoader','runner','run','tests/wire/currentLaunchpad.test.ts','tests/wire/launchpadRecovery.wire.test.ts']
with (out/'native.log').open('w') as log:r=subprocess.run(command,cwd=w,env=env,stdout=log,stderr=subprocess.STDOUT)
changed=[f['path'] for f in files if sha(Path(f['path']))!=f['sha256']]
receipt={'schema':'launchpad-ledger-native-run-v1','command':command,'cwd':str(w),'startedAt':lock['startedAt'],'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':r.returncode,'sourceLockSha256':sha(out/'source-lock.json'),'changedSources':changed,'outputs':[{'path':str(p.relative_to(out)),'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted([*(out/'captures').glob('*.json'),*(out/'complete').glob('*.json'),*(out/'refund').glob('*.json')])],'logSha256':sha(out/'native.log')}
(out/'completion.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:v for k,v in receipt.items() if k!='outputs'},indent=2));sys.exit(r.returncode or bool(changed))
