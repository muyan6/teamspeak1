import { createServer, type Server, type Socket } from 'node:net';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const dependencyRequire = createRequire(resolve(process.env.DEPENDENCY_TEST_ROOT ?? process.cwd(), 'package.json'));
const { getUri } = dependencyRequire('get-uri');
const ftp = dependencyRequire('basic-ftp');

/** Minimal loopback FTP fixture. This tests the real get-uri/basic-ftp API and
 * protocol integration (access, MDTM, MLSD fallback, downloadTo and close). */
async function fixture(listFallback = false) {
  const sockets = new Set<Socket>(), dataServers = new Set<Server>(), commands: string[] = [];
  const content = Buffer.from('synthetic FTP audio fixture\n');
  const track = (socket: Socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    return socket;
  };
  const server = createServer(raw => {
    const socket = track(raw);
    let buffer = '', dataConnection: Promise<Socket> | null = null;
    const reply = (text: string) => socket.write(text + '\r\n');
    async function handle(line: string) {
      const verb = line.split(' ')[0]; commands.push(line);
      switch (verb) {
        case 'USER': reply('331 Password required'); break;
        case 'PASS': reply('230 Logged in'); break;
        case 'FEAT': reply('211-Features\r\n MLST type*;size*;modify*;\r\n211 End'); break;
        case 'OPTS': case 'TYPE': case 'STRU': reply('200 OK'); break;
        case 'PWD': reply('257 "/" is current directory'); break;
        case 'CWD': reply('250 Directory changed'); break;
        case 'MDTM':
          reply(line.includes('missing') ? '550 Not found' : listFallback ? '500 MDTM unsupported' : '213 20261005080000');
          break;
        case 'EPSV': {
          let accept!: (socket: Socket) => void;
          dataConnection = new Promise(resolve => { accept = resolve; });
          const dataServer = createServer(data => { accept(track(data)); dataServer.close(); });
          dataServers.add(dataServer); dataServer.on('close', () => dataServers.delete(dataServer));
          await new Promise<void>(resolve => dataServer.listen(0, '127.0.0.1', resolve));
          reply(`229 Entering Extended Passive Mode (|||${(dataServer.address() as any).port}|)`);
          break;
        }
        case 'MLSD': case 'LIST': case 'RETR': {
          if (!dataConnection) { reply('425 No data connection'); break; }
          reply('150 Opening data connection');
          const data = await dataConnection; dataConnection = null;
          data.once('close', () => { if (!socket.destroyed) reply('226 Transfer complete'); });
          data.end(verb === 'RETR' ? content : `type=file;size=${content.length};modify=20261005080000; fixture.txt\r\n`);
          break;
        }
        case 'QUIT': reply('221 Goodbye'); socket.end(); break;
        default: reply('502 Command not implemented');
      }
    }
    let chain = Promise.resolve();
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        chain = chain.then(() => handle(line)).catch(() => { socket.destroy(); });
      }
    });
    reply('220 Loopback test fixture');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ftp://fixture:synthetic@127.0.0.1:${(server.address() as any).port}/fixture.txt`, commands, content,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([server, ...dataServers].map(s => new Promise<void>(resolve => s.close(() => resolve()))));
    },
  };
}

it('uses the patched basic-ftp release and retains normal Unix/MLSD parsing', () => {
  expect(dependencyRequire('basic-ftp/package.json').version).toBe('6.2.2');
  const unix = ftp.parseList('-rw-r--r-- 1 owner group 12 Oct 05 2026 fixture.txt\r\n');
  expect(unix[0]).toMatchObject({ name: 'fixture.txt', size: 12 });
  const mlsd = ftp.parseList('type=file;size=12;modify=20261005080000; fixture.txt\r\n');
  expect(mlsd[0]).toMatchObject({ name: 'fixture.txt', size: 12, modifiedAt: new Date('2026-10-05T08:00:00Z') });
});

it.each([false, true])('get-uri downloads through basic-ftp 6.2.2, MLSD fallback=%s', async fallback => {
  const server = await fixture(fallback);
  try {
    const stream = await getUri(server.url);
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(server.content);
    expect(stream.lastModified).toEqual(new Date('2026-10-05T08:00:00Z'));
    expect(server.commands).toContain('USER fixture'); expect(server.commands).toContain('RETR /fixture.txt');
    if (fallback) expect(server.commands.some(command => command.startsWith('MLSD'))).toBe(true);
    await expect(getUri(server.url, { cache: stream })).rejects.toMatchObject({ code: 'ENOTMODIFIED' });
    await expect(getUri(server.url.replace('fixture.txt', 'missing.txt'))).rejects.toMatchObject({ code: 'ENOTFOUND' });
  } finally { await server.close(); }
}, 10000);
