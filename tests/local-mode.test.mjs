import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

test('no-key local mode, isolated from live agents', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bot-hq-test-'));
  const env = {
    PATH: process.env.PATH, HOME: dir,
    HQ_DESKTOP: 'none', HQ_LOCAL: '0', PORT: '0',
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'), DEV_LOGIN: '1',
    DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'),
    HERMES_HOME_PRIMARY: path.join(dir, 'hermes'), HERMES_URL: 'http://127.0.0.1:1',
    GROKBOT_NO_SCHEDULER: '1',
  };
  const proc = spawn(process.execPath, ['dist/index.js'], { cwd: new URL('../server/', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  t.after(async () => {
    if (proc.exitCode === null) {
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      proc.kill('SIGTERM'); await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10000;
  while (!logs.match(/server on http:\/\/localhost:(\d+)/) && proc.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const match = logs.match(/server on http:\/\/localhost:(\d+)/);
  assert.ok(match, logs);
  const base = `http://127.0.0.1:${match[1]}`;
  const request = (p, options) => fetch(base + p, options);
  assert.equal((await request('/api/health')).status, 200);
  assert.match(await (await request('/')).text(), /<div id="root">/);
  assert.equal((await request('/api/bots')).status, 401);
  const badHostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/health', { headers: { Host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await request('/api/auth/dev', { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{"email":"evil@example.com"}' })).status, 403);
  const auth = await (await request('/api/auth/me')).json();
  assert.deepEqual(auth.capabilities, { desktop: false, apps: false, voice: false });
  assert.equal((await request('/api/auth/google/start')).status, 503);
  const login = await request('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"local@example.com"}' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const options = { headers: { Cookie: cookie } };
  const bots = await (await request('/api/bots', options)).json();
  assert.equal(bots.bots.length, 1);
  const computer = await (await request('/api/computer', options)).json();
  assert.match(JSON.stringify(computer), /Desktop disabled/);
  assert.equal((await request('/api/voice/voices', options)).status, 503);
  assert.equal((await request('/api/apps/catalog', options)).status, 503);
  const create = await request('/api/bots', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"name":"extra"}' });
  assert.notEqual(create.status, 200);
  assert.match(await create.text(), /one existing Hermes agent/);

  // Exercise direct tool paths too, with any attempted network call made fatal.
  const checks = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    globalThis.fetch = () => { throw new Error('unexpected outbound fetch'); };
    const { orgo } = await import('./dist/orgo.js');
    await assert.rejects(orgo.listScreens('not-real'), /Desktops are disabled/);
    const { composioTools, connectedToolkits } = await import('./dist/composio.js');
    assert.deepEqual(await composioTools('test'), []);
    assert.equal((await connectedToolkits('test')).size, 0);
    const { toolMap } = await import('./dist/agent/tools.js');
    await assert.rejects(toolMap.get('x_search').impl({query:'test'}, {}), /X research is disabled/);
    const { db } = await import('./dist/db.js');
    const owner = db.prepare('SELECT id FROM users LIMIT 1').get().id;
    const insert = db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,0,0)');
    insert.run('old-managed', owner, 'Old managed', 'managed');
    insert.run('old-unassigned', owner, 'Old unassigned', null);
    const engines = await import('./dist/engine.js');
    engines.initEngines();
    assert.equal(db.prepare('SELECT engine FROM bots WHERE id=?').get('old-unassigned').engine, null);
    assert.throws(() => engines.assignEngine('old-managed'), /disabled in local mode/);
    assert.throws(() => engines.assignEngine('old-unassigned'), /disabled in local mode/);
    await assert.rejects(engines.engineFor('old-managed'), /disabled in local mode/);
    await assert.rejects(engines.engineFor('old-unassigned'), /disabled in local mode/);
    await assert.rejects(engines.restartEngine('old-managed'), /disabled in local mode/);
    engines.provisionEngine('old-managed');
    engines.syncPersona('old-managed');
    await engines.removeEngine('old-managed');
    assert.equal(engines.engineHome('old-managed'), null);
    assert.match((await engines.engineInfo('old-managed')).error, /disabled in local mode/);
    const fs = await import('node:fs');
    assert.equal(fs.existsSync(process.env.ENGINES_DIR), false, 'must not create managed homes or copy credentials');
  `], { cwd: new URL('../server/', import.meta.url), env, encoding: 'utf8' });
  assert.equal(checks.status, 0, checks.stderr);
  const invalid = spawnSync(process.execPath, ['dist/env.js'], { cwd: new URL('../server/', import.meta.url), env: { ...env, HQ_LOCAL: '1' }, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /HQ_LOCAL=1 requires/);
});
