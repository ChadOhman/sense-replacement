import { useEffect, useRef, useState } from 'react';
import type { LiveFrame, LiveMessage, PowerPoint } from '@sense/shared';

const WINDOW_S = 3600;

export interface LiveState {
  frame: LiveFrame | null;
  series: PowerPoint[];
  stale: boolean;
  connected: boolean;
  cloudConnected: boolean;
}

export function useLiveSocket(): LiveState {
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [series, setSeries] = useState<PowerPoint[]>([]);
  const [connected, setConnected] = useState(false);
  const [cloudConnected, setCloudConnected] = useState(true);
  const [stale, setStale] = useState(false);
  const lastMessageAt = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let backoff = 1000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = (): void => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/live`);
      ws.onopen = () => {
        backoff = 1000;
        setConnected(true);
      };
      ws.onmessage = (ev) => {
        lastMessageAt.current = Date.now();
        let msg: LiveMessage;
        try {
          msg = JSON.parse(ev.data as string) as LiveMessage;
        } catch {
          return;
        }
        if (msg.kind === 'history') {
          setSeries(msg.points);
        } else if (msg.kind === 'frame') {
          const f = msg.frame;
          setFrame(f);
          setSeries((prev) => {
            const cutoff = f.ts - WINDOW_S;
            const next = prev.filter((p) => p.t >= cutoff);
            next.push({ t: f.ts, wAvg: f.w, wMin: f.w, wMax: f.w });
            return next;
          });
        } else if (msg.kind === 'status') {
          setCloudConnected(msg.cloudConnected);
        }
      };
      const scheduleReconnect = (): void => {
        setConnected(false);
        if (closed || reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
      ws.onclose = scheduleReconnect;
      ws.onerror = () => ws?.close();
    };

    connect();
    const staleTimer = setInterval(() => {
      setStale(Date.now() - lastMessageAt.current > 10_000);
    }, 1000);

    return () => {
      closed = true;
      clearInterval(staleTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  return { frame, series, stale, connected, cloudConnected };
}
