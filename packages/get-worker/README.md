# omo-get-worker

## Launch video

`/launch` serves the launch player and social-preview metadata. The public media routes are an explicit allowlist, not a general R2 object proxy:

| Public URL | Object key in `omo-releases` | Content type |
| --- | --- | --- |
| `https://get.omo.dev/media/launch-20261024.mp4` | `public/launch/2026-10-24/demo.mp4` | `video/mp4` |
| `https://get.omo.dev/media/launch-20261024.jpg` | `public/launch/2026-10-24/poster.jpg` | `image/jpeg` |

Upload only approved media, using credentials for the account in the deployment configuration. The URLs are permanent and unsigned; no bucket public-access or account settings need changing.

```sh
wrangler r2 object put omo-releases/public/launch/2026-10-24/demo.mp4 \
  --file /path/to/approved-demo.mp4 --content-type video/mp4 \
  --cache-control 'public, max-age=31536000, immutable' --remote \
  --config wrangler.jsonc
wrangler r2 object put omo-releases/public/launch/2026-10-24/poster.jpg \
  --file /path/to/approved-poster.jpg --content-type image/jpeg \
  --cache-control 'public, max-age=31536000, immutable' --remote \
  --config wrangler.jsonc
```

Deploy through `get-worker-deploy.yml` after review and merge, then check `/launch` returns 200, the player and OG metadata reference those URLs, and an MP4 request with `Range: bytes=0-1` returns 206, `Content-Type: video/mp4`, and the matching `Content-Range`. Treat these object keys as immutable; a later video gets new keys and URLs.
