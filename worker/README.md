# 纸间四音色网关

This optional Cloudflare Worker makes the existing four Chinese voices
available to the static reader while the author's PC is off. It accepts only
`xiaoxiao`, `xiaoyi`, `yunxi`, and `yunyang`; it never enumerates device voices.

## Deployment

1. Create a Cloudflare Workers account and a Worker named `zhijian-reader-voice`.
2. Either run `npm install` and `npm run deploy` in this directory, or build with
   `npm run bundle` and paste the complete `dist/worker.js` into a dashboard
   JavaScript Worker (ES module format).
3. Set the variable `ALLOWED_ORIGINS` to `https://chihiro011012.github.io`.
   For local development only, append the exact local origin separated by a
   comma (for example `http://localhost:5173`). Do not use a wildcard.
4. Put the deployed HTTPS endpoint ending in `/v1/tts` in the reader's service
   configuration. A successful `/health` only confirms deployment; verify
   synthesis separately with a short self-authored test sentence.

No Azure key or Cloudflare token is put in the browser. Do not commit account
tokens, private novels, generated audio or local configuration. Do not enable
request-body logging. This gateway does not store or log submitted text.

## API and operating limits

`POST /v1/tts`, `Content-Type: application/json`, with an allowed browser
`Origin`. Body example: `{"text":"窗外的雨停了。","voice":"xiaoxiao"}`.
Success returns an `audio/mpeg` body with `Cache-Control: no-store`.
The reader may cache the result locally after the user's first-use consent.

Limits: 32 KiB request, 2000 Unicode codepoints, 8 MB audio, 25 seconds per
upstream text part. Escaped text is split at complete Unicode codepoints into
parts of at most 3000 UTF-8 bytes. Empty text, XML control characters and other
voice IDs are rejected. Client cancellation closes the current connection.
Only the four fixed upstream voice identities can be requested; this is not
an arbitrary URL proxy. CORS is a browser restriction rather than authentication;
the public endpoint can still consume the hosting account's free quota. Add
Cloudflare rate limits if needed and monitor request counts.

This is an unofficial Edge service client. Microsoft or Cloudflare can change
compatibility or limits; free quota and ongoing availability are not promised.
Cloudflare access from the intended phone/network must be tested before relying
on it for travel. Existing local `.zjbook` audio remains independent of it.

See `NOTICE.md`, `LICENSE.edge-tts` (upstream notice and LGPLv3) and
`LICENSE.GPL-3.0` (the GPLv3 terms incorporated by LGPLv3) for source and license
details. Keep both license files when redistributing this gateway.
