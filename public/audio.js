// Shared soundboard playback. The GM triggers sounds on the server; every client plays them in sync
// by computing how long ago the server started them (corrected for clock difference).
//
// ROADMAP 3 §4.1: a sound may also be a YouTube video. It plays in YouTube's own embedded player (IFrame API) in each browser:
// never downloaded or converted. The player stays visible (small, in a corner) while it plays, as YouTube asks of embeds.
// Sync is rougher than for files (the player seeks once it is ready). Ads, videos that forbid embedding and blocked YouTube are limits.
export function createAudio({ getOffset, onBlocked }) {
  const playing = new Map(); // sound id -> { el | yt, sound, startedAt }
  const store = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const keep = (k, v) => { try { localStorage.setItem(k, v); } catch { /* not kept */ } };
  let master = Number(store('vol', 0.8)), muted = store('mute', '0') === '1';
  const level = (s) => (muted ? 0 : Math.min(1, Math.max(0, s.volume * master)));
  const tryPlay = (el) => el.play().catch(() => onBlocked());
  const elapsedOf = (startedAt) => Math.max(0, (Date.now() + getOffset() - startedAt) / 1000);

  // ---------------------------------------------------------------- YouTube
  let ytReady = null, dock = null;
  function loadYouTube() {
    if (ytReady) return ytReady;
    ytReady = new Promise((resolve, reject) => {
      if (window.YT?.Player) return resolve(window.YT);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api'; s.async = true;
      s.onerror = () => { ytReady = null; reject(new Error('YouTube cannot be reached')); };
      document.head.append(s);
    });
    return ytReady;
  }
  function dockEl() {
    if (!dock) { dock = document.createElement('div'); dock.className = 'yt-dock'; document.body.append(dock); }
    return dock;
  }
  function startYouTube(sound, startedAt) {
    const box = document.createElement('div'); box.className = 'yt-box';
    const title = document.createElement('div'); title.className = 'yt-title'; title.textContent = '♪ ' + sound.name;
    const slot = document.createElement('div'); box.append(title, slot); dockEl().append(box);
    const rec = { yt: null, box, sound, startedAt }; playing.set(sound.id, rec);
    loadYouTube().then((YT) => {
      if (playing.get(sound.id) !== rec) return; // stopped meanwhile
      const at = elapsedOf(startedAt);
      rec.yt = new YT.Player(slot, {
        width: 200, height: 113, videoId: sound.videoId,
        playerVars: { autoplay: 1, controls: 1, playsinline: 1, start: Math.floor(at), rel: 0, ...(sound.loop ? { loop: 1, playlist: sound.videoId } : {}) },
        events: {
          onReady: (e) => {
            const p = e.target, dur = p.getDuration?.() || 0, now = elapsedOf(startedAt);
            if (!sound.loop && dur && now >= dur) return stop(sound.id); // already over for everyone else
            p.setVolume(Math.round(level(rec.sound) * 100));
            p.seekTo(sound.loop && dur ? now % dur : now, true); p.playVideo();
            setTimeout(() => { if (playing.get(sound.id) === rec && p.getPlayerState?.() !== YT.PlayerState.PLAYING) onBlocked(); }, 2500);
          },
          onStateChange: (e) => { if (e.data === YT.PlayerState.ENDED && !rec.sound.loop) stop(sound.id); },
          onError: () => { title.textContent = '♪ ' + sound.name + ' ✕'; }, // e.g. the video forbids embedding
        },
      });
    }).catch(() => { title.textContent = '♪ ' + sound.name + ' ✕'; });
  }

  // ---------------------------------------------------------------- common
  function stop(id) {
    const r = playing.get(id); if (!r) return;
    playing.delete(id);
    if (r.el) { r.el.pause(); r.el.removeAttribute('src'); r.el.load(); }
    if (r.box) { try { r.yt?.destroy(); } catch { /* already gone */ } r.box.remove(); }
  }
  function start(sound, startedAt) {
    stop(sound.id);
    if (sound.kind === 'youtube') return startYouTube(sound, startedAt);
    const el = new Audio(); el.preload = 'auto'; el.loop = sound.loop; el.volume = level(sound);
    const rec = { el, sound, startedAt }; playing.set(sound.id, rec);
    el.addEventListener('loadedmetadata', () => {
      const elapsed = elapsedOf(startedAt);
      if (!sound.loop && elapsed >= el.duration) return stop(sound.id); // it already finished for everyone else
      try { el.currentTime = sound.loop && el.duration ? elapsed % el.duration : elapsed; } catch { /* not seekable yet */ }
      tryPlay(el);
    });
    el.addEventListener('ended', () => { if (!sound.loop) playing.delete(sound.id); });
    el.src = sound.url;
  }
  const setLevel = (r) => { if (r.el) r.el.volume = level(r.sound); else r.yt?.setVolume?.(Math.round(level(r.sound) * 100)); };
  const refresh = () => playing.forEach(setLevel);
  return {
    start, stop,
    stopAll: () => [...playing.keys()].forEach(stop),
    isPlaying: (id) => playing.has(id),
    update(sound) { const r = playing.get(sound.id); if (r) { r.sound = sound; if (r.el) r.el.loop = sound.loop; else r.yt?.setLoop?.(sound.loop); setLevel(r); } },
    apply(ev, sounds) {
      if (ev.op === 'play') { const s = sounds.find((x) => x.id === ev.id); if (s) start(s, ev.startedAt); }
      else if (ev.op === 'stop') stop(ev.id);
      else [...playing.keys()].forEach(stop);
    },
    sync(list, sounds) { for (const p of list) { const s = sounds.find((x) => x.id === p.id); if (s && !playing.has(s.id)) start(s, p.startedAt); } },
    unlock: () => playing.forEach((r) => { if (r.el) tryPlay(r.el); else r.yt?.playVideo?.(); }),
    getMaster: () => master, isMuted: () => muted,
    setMaster(v) { master = v; keep('vol', String(v)); refresh(); },
    setMuted(m) { muted = m; keep('mute', m ? '1' : '0'); refresh(); },
  };
}
