import {build} from 'esbuild';
import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export async function buildLab() {
  await rm('dist', {recursive:true, force:true});
  await mkdir('dist', {recursive:true});
  await cp('public', 'dist', {recursive:true});
  const worker = 'dist/survivors-research-simulation.worker.js';
  await build({entryPoints:['src/client/survivors-research/simulation.worker.js'], outfile:worker,
    bundle:true, format:'esm', platform:'browser', target:'es2022', minify:true});
  const engineHash = createHash('sha256').update(await readFile(worker)).digest('hex');
  await build({entryPoints:['src/client/survivors-research/main.js'], outfile:'dist/survivors-research.js',
    bundle:true, format:'esm', platform:'browser', target:'es2022', minify:true,
    define:{__MUNDI_RESEARCH_ENGINE_HASH__:JSON.stringify(engineHash), __MUNDI_COMMIT__:JSON.stringify('R165-independent')}});
  await writeFile('dist/build-info.json', JSON.stringify({snapshot:'R165', engine_sha256:engineHash}, null, 2) + '\n');
  console.log('Built independent research page and simulation Worker.');
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) await buildLab();
