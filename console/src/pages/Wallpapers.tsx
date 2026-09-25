import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Card, Empty, ErrorBanner, Field, PageHeader, Spinner, useAction, useAsync } from '../components/ui';
import { useSession } from '../session';
import type { Wallpaper } from '../types';

function Thumb({ id }: { id: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    void api.blob(`/wallpapers/${id}/content`).then((b) => setSrc((url = URL.createObjectURL(b))));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [id]);
  return src ? <img src={src} alt="" className="thumb" /> : <div className="thumb" />;
}

export default function WallpapersPage() {
  const { canCommand } = useSession();
  const { data, error, loading, reload } = useAsync(() => api.get<{ wallpapers: Wallpaper[] }>('/wallpapers'), []);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const up = useAction();

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    await up.run(async () => {
      const fd = new FormData();
      fd.append('name', name || file.name);
      fd.append('file', file);
      await api.post('/wallpapers', fd);
      setName('');
      setFile(null);
      (e.target as HTMLFormElement).reset();
      await reload();
    });
  }

  return (
    <>
      <PageHeader title="Wallpapers" subtitle="Branding and lock-screen instructions for your fleet. Set a fleet default in a policy or apply per device." />
      {canCommand && (
        <Card title="Upload">
          <form onSubmit={upload} className="inline-form">
            <ErrorBanner error={up.error} />
            <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
            <Field label="Image" hint="PNG, JPEG or WebP, up to 8 MB"><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required /></Field>
            <button className="btn btn-primary" disabled={up.busy || !file}>Upload</button>
          </form>
        </Card>
      )}
      <Card title="Library">
        <ErrorBanner error={error} />
        {loading ? <Spinner /> : !data?.wallpapers.length ? <Empty>No wallpapers uploaded.</Empty> : (
          <div className="gallery">
            {data.wallpapers.map((w) => (
              <figure key={w.id}>
                <Thumb id={w.id} />
                <figcaption><strong>{w.name}</strong><span className="muted small">{Math.round(w.sizeBytes / 1024)} KB</span></figcaption>
              </figure>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
