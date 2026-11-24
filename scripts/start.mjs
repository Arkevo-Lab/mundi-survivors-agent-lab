import {fileURLToPath} from 'node:url';
import {buildLab} from './build.mjs';
import {createLabServer} from './server.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const port = Number(process.env.PORT ?? 4188);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535');
await buildLab();
const server = createLabServer({env:process.env});
server.on('error', error => {console.error(error.code === 'EADDRINUSE' ? 'Port is busy. Set a different PORT in .env.' : 'Could not start local server.'); process.exitCode = 1;});
server.listen(port, '127.0.0.1', () => console.log(`Survivors Agent Lab R165\nhttp://127.0.0.1:${port}/?scenario=bat-crystal-bands-v1&release=R165\nNo model calls occur until you explicitly start an experiment. Ctrl+C stops the server.`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {server.close(() => process.exit(0)); server.closeAllConnections();});
