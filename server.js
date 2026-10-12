require('dotenv').config();
 
const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const path = require('path');
 
const app = express();
app.use(express.json());
 
const PORT = parseInt(process.env.PORT || '8888', 10);
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_USERNAME = process.env.LASTFM_USERNAME;
const PANEL_WIDTH = parseInt(process.env.PANEL_WIDTH || '32', 10);
const PANEL_HEIGHT = parseInt(process.env.PANEL_HEIGHT || '32', 10);
 
if (!LASTFM_API_KEY || !LASTFM_USERNAME) {
  console.warn('WARNING: LASTFM_API_KEY / LASTFM_USERNAME are not set. Copy .env.example to .env and fill them in.');
}
 
const nowPlaying = {
  isPlaying: false,
  trackKey: null,
  trackName: null,
  artistName: null,
  albumName: null,
  albumArtUrl: null,
  updatedAt: 0,
};
 
let currentFrame = Buffer.alloc(PANEL_WIDTH * PANEL_HEIGHT * 2, 0);
let currentFrameKey = null;
 
// Panel brightness, 0-255, set by the slider on the webpage, read by the ESP32
let panelBrightness = 180;
 
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
 
async function fetchAlbumArtUrl(artistName, trackName) {
  const term = `${artistName} ${trackName}`.trim();
  if (!term) return null;
 
  const resp = await axios.get('https://itunes.apple.com/search', {
    params: { term, entity: 'song', limit: 1 },
  });
 
  const result = resp.data?.results?.[0];
  if (!result?.artworkUrl100) return null;
  return result.artworkUrl100.replace('100x100bb', '600x600bb');
}
 
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
 
async function renderFrame(imageUrl) {
  const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  const { data } = await sharp(imgResp.data)
    .resize(PANEL_WIDTH, PANEL_HEIGHT, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
 
  const frame = Buffer.alloc(PANEL_WIDTH * PANEL_HEIGHT * 2);
  for (let i = 0, p = 0; i < data.length; i += 3, p += 2) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const rgb565 = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
    frame.writeUInt16BE(rgb565, p);
  }
  currentFrame = frame;
}
 
setInterval(pollNowPlaying, 5000);
 
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
 
app.get('/api/frame', (req, res) => {
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Track-Key', nowPlaying.trackKey || '');
  res.set('X-Is-Playing', nowPlaying.isPlaying ? '1' : '0');
  res.set('X-Panel-Width', String(PANEL_WIDTH));
  res.set('X-Panel-Height', String(PANEL_HEIGHT));
  res.send(currentFrame);
});
 
app.get('/api/nowplaying', (req, res) => {
  res.json({
    configured: !!(LASTFM_API_KEY && LASTFM_USERNAME),
    ...nowPlaying,
  });
});
 
// Panel brightness - GET for the ESP32 to poll, POST for the slider on the page
app.get('/api/brightness', (req, res) => {
  res.json({ brightness: panelBrightness });
});
 
app.post('/api/brightness', (req, res) => {
  const value = parseInt(req.body?.brightness ?? req.query.brightness, 10);
  if (Number.isNaN(value) || value < 0 || value > 255) {
    return res.status(400).json({ error: 'brightness must be 0-255' });
  }
  panelBrightness = value;
  res.json({ ok: true, brightness: panelBrightness });
});
 
app.use(express.static(path.join(__dirname, 'public')));
 
app.listen(PORT, () => {
  console.log(`LED Spotify server listening on http://127.0.0.1:${PORT}`);
  console.log('Make sure Spotify -> Last.fm scrobbling is connected, then play something.');
});
 