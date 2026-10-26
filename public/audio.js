// Shared soundboard playback. The GM triggers sounds on the server; every client plays them in sync
// by computing how long ago the server started them (corrected for clock difference).
export function createAudio({ getOffset, onBlocked }) {
  const playing = new Map(); // sound id -> { el, sound, startedAt }
  let master = Number(localStorage.getItem('vol') ?? 0.8), muted = localStorage.getItem('mute') === '1';
  const level = (s) => (muted ? 0 : Math.min(1, Math.max(0, s.volume * master)));
  const tryPlay = (el) => el.play().catch(() => onBlocked());

  function stop(id) {
    const r = playing.get(id); if (!r) return;
    r.el.pause(); r.el.removeAttribute('src'); r.el.load(); playing.delete(id);
  }
  function start(sound, startedAt) {
    stop(sound.id);
    const el = new Audio(); el.preload = 'auto'; el.loop = sound.loop; el.volume = level(sound);
    const rec = { el, sound, startedAt }; playing.set(sound.id, rec);
    el.addEventListener('loadedmetadata', () => {
      const elapsed = Math.max(0, (Date.now() + getOffset() - startedAt) / 1000);
      if (!sound.loop && elapsed >= el.duration) return stop(sound.id); // it already finished for everyone else
      try { el.currentTime = sound.loop && el.duration ? elapsed % el.duration : elapsed; } catch { /* not seekable yet */ }
      tryPlay(el);
    });
    el.addEventListener('ended', () => { if (!sound.loop) playing.delete(sound.id); });
    el.src = sound.url;
  }
  const refresh = () => playing.forEach((r) => { r.el.volume = level(r.sound); });
  return {
    start, stop,
    stopAll: () => [...playing.keys()].forEach(stop),
    isPlaying: (id) => playing.has(id),
    update(sound) { const r = playing.get(sound.id); if (r) { r.sound = sound; r.el.loop = sound.loop; r.el.volume = level(sound); } },
    apply(ev, sounds) {
      if (ev.op === 'play') { const s = sounds.find((x) => x.id === ev.id); if (s) start(s, ev.startedAt); }
      else if (ev.op === 'stop') stop(ev.id);
      else [...playing.keys()].forEach(stop);
    },
    sync(list, sounds) { for (const p of list) { const s = sounds.find((x) => x.id === p.id); if (s && !playing.has(s.id)) start(s, p.startedAt); } },
    unlock: () => playing.forEach((r) => tryPlay(r.el)),
    getMaster: () => master, isMuted: () => muted,
    setMaster(v) { master = v; localStorage.setItem('vol', String(v)); refresh(); },
    setMuted(m) { muted = m; localStorage.setItem('mute', m ? '1' : '0'); refresh(); },
  };
}
