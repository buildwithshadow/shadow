import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
if(process.platform!=='linux'||process.arch!=='x64')throw Error('Foundry CI package requires Linux x64');
const version='1.7.1',commit='4072e48705af9d93e3c0f6e29e93b5e9a40caed8';
for(const tool of ['forge','cast','anvil']){
 const base=new URL(`./node_modules/@foundry-rs/${tool}-linux-amd64/`,import.meta.url);
 const pkg=JSON.parse(readFileSync(new URL('package.json',base),'utf8'));
 if(pkg.version!==version)throw Error(`Unexpected ${tool} package version`);
 const result=spawnSync(fileURLToPath(new URL(`bin/${tool}`,base)),['--version'],{encoding:'utf8',timeout:10000});
 if(result.error||result.status!==0||!result.stdout.includes(`Version: ${version}`)||!result.stdout.includes(`Commit SHA: ${commit}`))throw Error(`Unexpected ${tool} binary identity`);
 console.log(`${tool} ${version} ${commit}`);
}
