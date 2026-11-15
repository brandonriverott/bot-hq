import { useEffect, useState } from 'react';
import type { ScreenProps } from './ComputerViewer';

/** Cua's viewer disallows framing. Preserve that CSP and open its scoped ticket in a new tab. */
export function CuaComputerScreen({ bot, variant, paused, onExpand }: ScreenProps) {
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (paused) return;
    let disposed = false, current: string | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const ctrl = new AbortController();
    const capture = async () => {
      try {
        const response = await fetch(`/api/bots/${bot.id}/screenshot`, { signal: ctrl.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Desktop is unavailable. Check its sandbox in Cua Spaces.');
        const next = URL.createObjectURL(await response.blob());
        if (disposed) { URL.revokeObjectURL(next); return; }
        if (current) URL.revokeObjectURL(current);
        current = next; setImage(next); setError(null);
      } catch (e) { if (!disposed) setError((e as Error).message); }
      if (!disposed) timer = setTimeout(capture, 2000);
    };
    void capture();
    return () => { disposed = true; ctrl.abort(); clearTimeout(timer); if (current) URL.revokeObjectURL(current); };
  }, [bot.id, paused]);
  useEffect(() => { setLink(null); }, [bot.id]);
  const prepare = async (mode: 'watch' | 'control') => {
    setBusy(true); setError(null); setLink(null);
    try {
      const response = await fetch(`/api/bots/${bot.id}/cua/viewer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not prepare the viewer.');
      setLink(data);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section aria-label={`${bot.name}'s Cua desktop`} style={{ padding: 12 }}>
    {image && !paused && <img src={image} alt="Current Cua sandbox desktop" style={{ width: '100%', display: 'block', borderRadius: 8 }} />}
    <p style={{ fontSize: 12 }}>Cua desktop · refreshes every 2 seconds. The full viewer opens separately.</p>
    {paused ? <p>Desktop open in the large view.</p> : <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {variant === 'panel' && <button className="btn btn--secondary" onClick={() => onExpand?.('watch')}>Expand</button>}
      <button className="btn btn--secondary" disabled={busy} onClick={() => prepare('watch')}>Watch</button>
      <button className="btn btn--secondary" disabled={busy} onClick={() => prepare('control')}>Take control</button>
      {link && link.expiresAt > Date.now() && <a className="btn btn--primary" href={link.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open Cua viewer</a>}
      {busy && <span role="status">Preparing viewer…</span>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
