import L from 'leaflet';
import { useEffect, useRef } from 'react';

export interface Point {
  lat: number;
  lng: number;
  ts: string;
  accuracy?: number;
}
export interface Fence {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusMeters: number;
}

/** Live position (latest point), history trail, and geofences (spec §4.3). */
export function LocationMap({ points, fences }: { points: Point[]; fences: Fence[] }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!el.current) return;
    map.current ??= L.map(el.current, { zoomControl: true }).setView([20.59, 78.96], 4);
    const m = map.current;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 }).addTo(m);
    const layer = L.layerGroup().addTo(m);
    for (const f of fences) {
      L.circle([f.lat, f.lng], { radius: f.radiusMeters, color: '#2563eb', weight: 1, fillOpacity: 0.08 }).bindTooltip(f.name).addTo(layer);
    }
    const trail = points.map((p) => [p.lat, p.lng] as [number, number]);
    if (trail.length > 1) L.polyline(trail, { color: '#d7141c', weight: 2, opacity: 0.6 }).addTo(layer);
    const latest = points[0];
    if (latest) {
      L.circleMarker([latest.lat, latest.lng], { radius: 8, color: '#fff', weight: 2, fillColor: '#d7141c', fillOpacity: 1 })
        .bindTooltip(`Latest · ${new Date(latest.ts).toLocaleString()}`)
        .addTo(layer);
      if (latest.accuracy) L.circle([latest.lat, latest.lng], { radius: latest.accuracy, color: '#d7141c', weight: 0, fillOpacity: 0.12 }).addTo(layer);
      m.setView([latest.lat, latest.lng], 15);
    }
    return () => {
      layer.remove();
    };
  }, [points, fences]);

  useEffect(() => () => {
    map.current?.remove();
    map.current = null;
  }, []);

  return <div ref={el} className="map" />;
}
