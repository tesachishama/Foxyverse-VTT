// Sounds from YouTube (ROADMAP 3 §4.1): played by YouTube's own embedded player in each browser, never downloaded or converted.
// Pure (no DOM): shared by the page, the server and the tests.

const HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;
const ID = /^[A-Za-z0-9_-]{11}$/;
/** The video id of a YouTube link (watch, youtu.be, embed, shorts, live, music), or null. */
export function youtubeId(url) {
  let u; try { u = new URL(String(url ?? '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !HOSTS.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const id = /youtu\.be$/i.test(u.hostname) ? parts[0]
    : parts[0] === 'watch' ? u.searchParams.get('v')
      : ['embed', 'shorts', 'live', 'v'].includes(parts[0]) ? parts[1] : null;
  return id && ID.test(id) ? id : null;
}
/** The one form we store. */
export const youtubeUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
