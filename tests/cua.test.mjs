import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
process.env.HQ_DESKTOP = 'none';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const { CuaDesktop } = await import('../server/dist/cua.js');
const { CUA_LIBRARY_PROGRAM } = await import('../server/dist/cua-library.js');
const valid = { id: 'local:bot-hq-desktop', location: 'local', kind: 'container', runtime: 'gvisor', state: 'running' };

test('rejects host, remote, path and unprotected runtime targets', async () => {
  for (const name of ['host', 'other', 'local:other', '../bot-hq-test', 'bot-hq-;id']) assert.throws(() => new CuaDesktop(name));
  for (const change of [{ id: 'host' }, { location: 'remote' }, { kind: 'vm' }, { runtime: 'runc' }]) {
    const desktop = new CuaDesktop('bot-hq-desktop', async () => JSON.stringify({ ...valid, ...change }));
    await assert.rejects(desktop.requireRunning(), /No host fallback/);
  }
  const stopped = new CuaDesktop('bot-hq-desktop', async () => JSON.stringify({ ...valid, state: 'stopped' }));
  await assert.rejects(stopped.command('true'), /stopped/);
});

test('commands are one guest argv value; validation precedes execution', async () => {
  const calls = [];
  const desktop = new CuaDesktop('bot-hq-desktop', async (args) => { calls.push(args); return JSON.stringify(args[1] === 'info' ? valid : { stdout: 'guest', stderr: '', returncode: 0 }); });
  const command = "printf '%s' '$(not-a-host-command); hello'";
  assert.deepEqual(await desktop.command(command), { output: 'guest', exit_code: 0 });
  assert.equal(calls[1].at(-1), command); assert.equal(calls[1][2], valid.id);
  const before = calls.length;
  await assert.rejects(desktop.command('x\0y'));
  await assert.rejects(desktop.command('true', 999));
  await assert.rejects(desktop.readLibraryFile('/guest/files', '../etc/passwd'));
  assert.equal(calls.length, before);
});

test('viewer modes produce separate scoped tickets and unsafe URLs fail', async () => {
  const calls = [];
  const expires = Math.floor(Date.now() / 1000) + 600;
  const desktop = new CuaDesktop('bot-hq-desktop', async (args) => { calls.push(args); return JSON.stringify(args[1] === 'info' ? valid : { url: 'http://127.0.0.1:1234/viewer/#ticket=test-only', expires_at_unix: expires }); });
  await desktop.viewer('watch'); await desktop.viewer('control');
  const views = calls.filter((a) => a[1] === 'view');
  assert.ok(views[0].includes('--view-only')); assert.ok(!views[1].includes('--view-only'));
  assert.ok(views.every((a) => a.includes('none') && a[2] === valid.id));
  for (const url of ['https://evil.example/viewer/#ticket=x', 'http://127.0.0.1:1/admin/#ticket=x', 'http://127.0.0.1:1/viewer/?root_token=x', 'http://user:password@127.0.0.1:1/viewer/#ticket=x']) {
    const bad = new CuaDesktop('bot-hq-desktop', async (args) => JSON.stringify(args[1] === 'info' ? valid : { url, expires_at_unix: expires }));
    await assert.rejects(bad.viewer('watch'), /unsafe/);
  }
});

test('captures PNG only to private temporary files and cleans up', async () => {
  let file;
  const desktop = new CuaDesktop('bot-hq-desktop', async (args) => {
    if (args[1] === 'info') return JSON.stringify(valid);
    file = args[args.indexOf('--output') + 1];
    const image = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(image); image.writeUInt32BE(1280,16); image.writeUInt32BE(800,20);
    await fs.writeFile(file, image); return '';
  });
  assert.equal((await desktop.screenshot()).length, 24);
  assert.deepEqual(desktop.dimensions, { width: 1280, height: 800 });
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('guest library uses pinned no-follow directory fds and enforces 8 MiB', async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hq-library-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const base = path.join(dir, 'library'), outside = path.join(dir, 'outside');
  await fs.mkdir(outside); await fs.mkdir(base);
  await fs.writeFile(path.join(outside, 'private.txt'), 'outside');
  const call = (mode, bot, relative = '', prelude = '') => spawnSync('python3', ['-c', prelude + CUA_LIBRARY_PROGRAM, mode, base, bot, relative], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(call('list', 'bot_safe').status, 0);
  const root = path.join(base, 'bot_safe');
  await fs.writeFile(path.join(root, 'proof.txt'), 'inside');
  const normal = call('read', 'bot_safe', 'proof.txt');
  assert.equal(normal.status, 0, normal.stderr); assert.equal(Buffer.from(normal.stdout.trim(), 'base64').toString(), 'inside');
  await fs.symlink(outside, path.join(base, 'bot_escape'));
  await fs.symlink(outside, path.join(root, 'escape'));
  await fs.symlink(path.join(outside, 'private.txt'), path.join(root, 'file-link'));
  for (const [bot, rel] of [['bot_escape','private.txt'],['bot_safe','escape/private.txt'],['bot_safe','file-link'],['bot_safe','../outside/private.txt']]) assert.notEqual(call('read',bot,rel).status,0);
  assert.notEqual(call('list','bot_escape').status,0);
  assert.notEqual(call('list','bot_safe','escape').status,0);
  assert.deepEqual(JSON.parse(call('list','bot_safe').stdout).map(x=>x.name),['proof.txt']);
  const boundary = path.join(root, 'boundary.bin');
  await fs.writeFile(boundary, Buffer.alloc(8*1024*1024));
  const exact = call('read','bot_safe','boundary.bin');
  assert.equal(exact.status,0,exact.stderr); assert.equal(Buffer.from(exact.stdout.trim(),'base64').length,8*1024*1024);
  await fs.appendFile(boundary,Buffer.from([1]));
  assert.notEqual(call('read','bot_safe','boundary.bin').status,0);
  await fs.link(path.join(outside,'private.txt'),path.join(root,'hardlink'));
  assert.notEqual(call('read','bot_safe','hardlink').status,0);
  // Real guest smoke exposed an implementation that ignores O_NOFOLLOW. Keep
  // lstat + descriptor identity checks as a second independent barrier.
  const ignoreNoFollow = 'import os\n_real_open=os.open\nos.open=lambda p,flags,*a,**kw:_real_open(p,flags & ~os.O_NOFOLLOW,*a,**kw)\n';
  assert.equal(call('read','bot_safe','proof.txt',ignoreNoFollow).status,0);
  assert.notEqual(call('read','bot_escape','private.txt',ignoreNoFollow).status,0);
  assert.notEqual(call('read','bot_safe','escape/private.txt',ignoreNoFollow).status,0);
  assert.notEqual(call('read','bot_safe','file-link',ignoreNoFollow).status,0);
  await fs.mkdir(path.join(root,'race-dir'));
  await fs.writeFile(path.join(root,'race-dir','private.txt'),'inside');
  const swapDirectory = ignoreNoFollow + `
_previous_open=os.open
def _race_open(p,flags,*a,**kw):
    if p=='race-dir':
        os.rename(${JSON.stringify(path.join(root,'race-dir'))},${JSON.stringify(path.join(root,'moved-dir'))})
        os.symlink(${JSON.stringify(outside)},${JSON.stringify(path.join(root,'race-dir'))})
    return _previous_open(p,flags,*a,**kw)
os.open=_race_open
`;
  assert.notEqual(call('read','bot_safe','race-dir/private.txt',swapDirectory).status,0);
  await fs.writeFile(path.join(root,'race-file'),'inside');
  const swapFile = ignoreNoFollow + `
_previous_open=os.open
def _race_open(p,flags,*a,**kw):
    if p=='race-file':
        os.rename(${JSON.stringify(path.join(root,'race-file'))},${JSON.stringify(path.join(root,'moved-file'))})
        os.symlink(${JSON.stringify(path.join(outside,'private.txt'))},${JSON.stringify(path.join(root,'race-file'))})
    return _previous_open(p,flags,*a,**kw)
os.open=_race_open
`;
  assert.notEqual(call('read','bot_safe','race-file',swapFile).status,0);
});
