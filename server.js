require('dotenv').config();

const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const path = require('path');

const app = express();

const PORT = parseInt(process.env.PORT || '8888', 10);
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_USERNAME = process.env.LASTFM_USERNAME;
const PANEL_WIDTH = parseInt(process.env.PANEL_WIDTH || '32', 10);
const PANEL_HEIGHT = parseInt(process.env.PANEL_HEIGHT || '32', 10);

if (!LASTFM_API_KEY || !LASTFM_USERNAME) {
  console.warn('WARNING: LASTFM_API_KEY / LASTFM_USERNAME are not set. Copy .env.example to .env and fill them in.');
}

// ---------------------------------------------------------------------------
// In-memory state. Single-user hobby server, no database.
// ---------------------------------------------------------------------------
const nowPlaying = {
  isPlaying: false,
  trackKey: null, // "artist||track", used to detect track changes
  trackName: null,
  artistName: null,
  albumName: null,
  albumArtUrl: null,
  updatedAt: 0,
};

// Raw RGB565 big-endian pixel buffer, PANEL_WIDTH * PANEL_HEIGHT * 2 bytes.
let currentFrame = Buffer.alloc(PANEL_WIDTH * PANEL_HEIGHT * 2, 0);
let currentFrameKey = null; // lets us skip re-rendering an unchanged track

// ---------------------------------------------------------------------------
// Last.fm: what's currently playing. This only needs an API key - no login,
// no OAuth, no Premium requirement. It works because Spotify is scrobbling
// your plays to Last.fm (Last.fm Settings -> Applications -> Spotify -> Connect).
// ---------------------------------------------------------------------------
async function fetchNowPlayingFromLastfm() {
  const resp = await axios.get('https://ws.audioscrobbler.com/2.0/', {
    params: {
      method: 'user.getrecenttracks',
      user: LASTFM_USERNAME,
      api_key: LASTFM_API_KEY,
      format: 'json',
      limit: 1,
    },
  });

  const track = resp.data?.recenttracks?.track?.[0];
  if (!track) return null;

  const isPlaying = track['@attr']?.nowplaying === 'true';
  return {
    isPlaying,
    trackName: track.name,
    artistName: track.artist?.['#text'] || '',
    albumName: track.album?.['#text'] || '',
  };
}

// ---------------------------------------------------------------------------
// iTunes Search API: free, keyless, no login. Used purely for artwork since
// Last.fm's own album art has been unreliable for years.
// ---------------------------------------------------------------------------
async function fetchAlbumArtUrl(artistName, trackName) {
  const term = `${artistName} ${trackName}`.trim();
  if (!term) return null;

  const resp = await axios.get('https://itunes.apple.com/search', {
    params: { term, entity: 'song', limit: 1 },
  });

  const result = resp.data?.results?.[0];
  if (!result?.artworkUrl100) return null;

  // iTunes serves artwork at arbitrary requested sizes by editing the URL -
  // swap the baked-in 100x100 for something bigger before we downsize it.
  return result.artworkUrl100.replace('100x100bb', '600x600bb');
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------
async function pollNowPlaying() {
  try {
    const info = await fetchNowPlayingFromLastfm();
    if (!info) {
      if (nowPlaying.isPlaying) {
        nowPlaying.isPlaying = false;
        nowPlaying.updatedAt = Date.now();
      }
      return;
    }

    nowPlaying.isPlaying = info.isPlaying;
    nowPlaying.trackName = info.trackName;
    nowPlaying.artistName = info.artistName;
    nowPlaying.albumName = info.albumName;
    nowPlaying.updatedAt = Date.now();

    const trackKey = `${info.artistName}||${info.trackName}`;
    if (trackKey !== currentFrameKey) {
      const artUrl = await fetchAlbumArtUrl(info.artistName, info.trackName);
      if (artUrl) {
        await renderFrame(artUrl);
        nowPlaying.albumArtUrl = artUrl;
      }
      currentFrameKey = trackKey;
    }
    nowPlaying.trackKey = trackKey;
  } catch (err) {
    console.error('Poll error:', err.response?.data || err.message);
  }
}

// Crops the album art into a circular "CD" shape: black outside the disc,
// a small dim spindle hole in the middle. The ESP32 is the one that spins
// this - a circle looks identical at every rotation angle around its own
// center, so rotating this texture on the panel gives a real spinning-disc
// look without the server needing to render every angle itself.
async function renderFrame(imageUrl) {
  const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  const { data } = await sharp(imgResp.data)
    .resize(PANEL_WIDTH, PANEL_HEIGHT, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const cx = (PANEL_WIDTH - 1) / 2;
  const cy = (PANEL_HEIGHT - 1) / 2;
  const outerRadius = Math.min(PANEL_WIDTH, PANEL_HEIGHT) / 2 - 0.5;
  const holeRadius = Math.max(1.5, outerRadius * 0.12);

  const frame = Buffer.alloc(PANEL_WIDTH * PANEL_HEIGHT * 2);
  for (let y = 0; y < PANEL_HEIGHT; y++) {
    for (let x = 0; x < PANEL_WIDTH; x++) {
      const i = (y * PANEL_WIDTH + x) * 3;
      const p = (y * PANEL_WIDTH + x) * 2;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      let r, g, b;
      if (dist > outerRadius) {
        r = g = b = 0; // outside the disc
      } else if (dist < holeRadius) {
        r = g = b = 40; // spindle hole
      } else {
        r = data[i];
        g = data[i + 1];
        b = data[i + 2];
      }
      const rgb565 = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
      frame.writeUInt16BE(rgb565, p);
    }
  }
  currentFrame = frame;
}

setInterval(pollNowPlaying, 3000); // tightened from 5s - Last.fm's own scrobble lag is still the bigger delay

// ---------------------------------------------------------------------------
// API for the ESP32
// ---------------------------------------------------------------------------

app.get('/api/status', (req, res) => {
  res.json({
    configured: !!(LASTFM_API_KEY && LASTFM_USERNAME),
    isPlaying: nowPlaying.isPlaying,
    trackKey: nowPlaying.trackKey,
  });
});

// Binary RGB565 frame, PANEL_WIDTH * PANEL_HEIGHT * 2 bytes, row-major, big-endian.
app.get('/api/frame', (req, res) => {
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Track-Key', nowPlaying.trackKey || '');
  res.set('X-Is-Playing', nowPlaying.isPlaying ? '1' : '0');
  res.set('X-Panel-Width', String(PANEL_WIDTH));
  res.set('X-Panel-Height', String(PANEL_HEIGHT));
  res.send(currentFrame);
});

// JSON metadata for the web dashboard.
app.get('/api/nowplaying', (req, res) => {
  res.json({
    configured: !!(LASTFM_API_KEY && LASTFM_USERNAME),
    ...nowPlaying,
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`LED Spotify server listening on http://127.0.0.1:${PORT}`);
  console.log('Make sure Spotify -> Last.fm scrobbling is connected, then play something.');
});
