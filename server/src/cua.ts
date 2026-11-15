import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { env } from './env.js';
import { CUA_LIBRARY_PROGRAM } from './cua-library.js';
import type { LibraryFile } from './types.js';

export type CuaRunner = (args: string[], timeout?: number) => Promise<string>;
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const run: CuaRunner = (args, timeout = 30_000) => new Promise((resolve, reject) => {
  execFile(env.cuaBin, args, {
    timeout, maxBuffer: 32 * 1024 * 1024,
    // No provider credentials, global target overrides, or daemon overrides.
    env: { PATH: process.env.PATH, HOME: os.homedir(), USER: process.env.USER, LANG: 'en_US.UTF-8' },
  }, (error, stdout) => error ? reject(new Error('Cua desktop operation failed or timed out.')) : resolve(stdout));
});

/** Only a specifically named local gVisor guest; never the host or a shared global cua-do target. */
export class CuaDesktop {
  readonly ref: string;
  private capture: Promise<Buffer> | null = null;
  private tickets = new Map<string, { url: string; expiresAt: number }>();
  dimensions = { width: 1280, height: 800 };
  constructor(readonly name: string, private execute: CuaRunner = run) {
    if (!/^bot-hq-[a-z0-9][a-z0-9-]{0,48}$/.test(name)) throw new Error('CUA_SANDBOX must name a bot-hq- local sandbox.');
    this.ref = `local:${name}`;
  }
  async info() {
    const info = JSON.parse(await this.execute(['sb', 'info', this.ref, '--json']));
    if (info.id !== this.ref || info.location !== 'local' || info.kind !== 'container' || info.runtime !== 'gvisor') {
      throw new Error('Cua target must be the configured local gVisor container. No host fallback is allowed.');
    }
    return { running: info.state === 'running', name: this.name };
  }
  async requireRunning() {
    if (!(await this.info()).running) throw new Error('The Cua desktop is stopped. Start its sandbox in Cua Spaces.');
  }
  async command(command: string, timeout = 30): Promise<{ output: string; exit_code: number }> {
    if (typeof command !== 'string' || !command.trim() || command.length > 200_000 || command.includes('\0')) throw new Error('Invalid guest command.');
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) throw new Error('Guest timeout must be 1–120 seconds.');
    await this.requireRunning();
    // The command is one argv value to cua. Only the guest interprets its shell syntax.
    const result = JSON.parse(await this.execute(['sb', 'exec', this.ref, '--timeout', String(timeout), '--json', '--', command], (timeout + 10) * 1000));
    if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || !Number.isInteger(result.returncode)) throw new Error('Invalid Cua exec response.');
    return { output: result.stdout + result.stderr, exit_code: result.returncode };
  }
  async screenshot(): Promise<Buffer> {
    if (this.capture) return this.capture;
    this.capture = this.captureOne().finally(() => { this.capture = null; });
    return this.capture;
  }
  private async library(mode: 'list' | 'read', bot: string, relative: string) {
    if (!/^bot_[A-Za-z0-9_-]{1,120}$/.test(bot) || typeof relative !== 'string' || relative.startsWith('/') || (relative && relative.split('/').some((part) => !part || part === '.' || part === '..')) || /[\0\r\n]/.test(relative)) throw new Error('Invalid library path.');
    return this.command(`python3 -c ${quote(CUA_LIBRARY_PROGRAM)} ${quote(mode)} '/home/cua/bot-hq/files' ${quote(bot)} ${quote(relative)}`);
  }
  async listLibrary(bot: string, relative: string): Promise<LibraryFile[]> {
    const result = await this.library('list', bot, relative);
    if (result.exit_code) throw new Error('Library directory unavailable.');
    return JSON.parse(result.output);
  }
  async readLibraryFile(bot: string, relative: string) {
    if (!relative) throw new Error('Invalid library path.');
    const result = await this.library('read', bot, relative);
    if (result.exit_code || !/^[A-Za-z0-9+/=\r\n]*$/.test(result.output)) throw new Error('Library file unavailable.');
    return Buffer.from(result.output.trim(), 'base64');
  }
  private async captureOne() {
    await this.requireRunning();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-hq-shot-'));
    try {
      const file = path.join(dir, 'screen.png');
      await this.execute(['sb', 'screenshot', this.ref, '--output', file]);
      if ((await fs.stat(file)).size > 32 * 1024 * 1024) throw new Error('Cua screenshot exceeds 32 MiB.');
      const image = await fs.readFile(file);
      if (image.length < 24 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Cua returned an invalid screenshot.');
      const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
      if (!width || !height || width > 8192 || height > 8192) throw new Error('Cua screenshot dimensions are invalid.');
      this.dimensions = { width, height };
      return image;
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  async viewer(mode: 'watch' | 'control') {
    if (mode !== 'watch' && mode !== 'control') throw new Error('Invalid viewer mode.');
    await this.requireRunning();
    const cached = this.tickets.get(mode);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
    const args = ['sb', 'view', this.ref, '--no-open', '--files', 'none', '--ttl', '10m', '--json'];
    if (mode === 'watch') args.push('--view-only');
    const result = JSON.parse(await this.execute(args, 60_000));
    const url = new URL(result.url);
    const expiresAt = Number(result.expires_at_unix) * 1000;
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/viewer/' || url.username || url.password || url.search || !new URLSearchParams(url.hash.slice(1)).has('ticket') || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Cua returned an unsafe viewer link.');
    const ticket = { url: url.href, expiresAt };
    this.tickets.set(mode, ticket);
    return ticket;
  }
}

export const cuaDesktop = new CuaDesktop(env.cuaSandbox);
