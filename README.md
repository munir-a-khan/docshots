# DocShots

Copy every image out of a Google Doc, in order, and paste it into Discord, a forum or any app one at a time,
with a live "How it works" diagram of every job. Built for Replit's internship challenge, "Build an App that
Shows Its Work".

## The task it takes off my plate

Images in a Google Doc can't be copied out into Discord or most other apps. I keep a log of game runs as a doc
(a heading per character, a numbered list, one to three screenshots per entry), and the community I submit to
only accepts images posted directly, numbered. Moving 347 screenshots by hand meant saving each one, renaming it
and keeping each entry's images together. DocShots does that from the doc's link: it pulls every image out in
order, keeps each numbered entry's images together, flags what's missing, and gives me a paste queue that puts
the next text line or image on the clipboard with one key.

It works for any doc built from headings, numbered lists and images. A Warframe preset adds what my own use
needs: the character portrait for each section, and the map name read from each end-of-mission screenshot.

## How a job works

| Step | Where | What it does |
| --- | --- | --- |
| Check link | Browser → server | Pulls the doc ID out of any Docs link. The link is saved before anything can fail. |
| Download the doc | Google Docs | Streams `export?format=md`, gzip-compressed. Retries twice with backoff; a private doc stops with sharing instructions; over 400 MB stops with a clear message. |
| Read structure | Server | Headings → sections, `N.` lines → entries, indented lines and nested items → that entry's notes and images. Runs while the download continues. |
| Extract images | Server → storage | Up to four images decode at once while the download streams on. Images seen in an earlier job are recognised from a hash of their base64 text, without decoding. |
| Group entries | Server | Maps each image to its section and entry in document order. |
| Check | Server | Flags entries with no image, duplicate images, images missing from the export, tiny images. |
| Save | Postgres | Sections, entries and images in a few batched inserts. |
| Suggest map names | Public game data | Warframe preset only: OCRs the map line and ranks it against the 88 arbitration maps. Each screenshot is read once ever. |

Every step emits start, progress, done, warn, fail or retry events. They stream to the page over server-sent
events and are stored, so the replay shows exactly what happened, at 1×, 10×, 50× or event by event. Nothing in
the job is slowed down to make it watchable.

## Failure handling

- **Doc not shared or link wrong:** the download step turns red and says how to share the doc. The link stays
  saved, and "Try Again" reruns it.
- **Network errors, stalls (60 s without data) or a cut-off download:** retried twice with backoff, each retry
  shown on the diagram. A cut-off download is detected because every image definition ends with `>`. Images
  already saved are kept and reused on the retry.
- **Images the export lacks, or that fail to decode:** flagged on the entry; the job continues.
- **Public game data unavailable:** map suggestions are skipped with a note; everything else finishes.
- **Too many jobs:** two running and twenty per hour per browser, with a message saying what to do.

## Numbers from my own doc

248 entries, 347 PNG screenshots, 139 MB of Markdown (110 MB gzipped on the wire).

| | First job | Same doc again |
| --- | --- | --- |
| Download (Google takes ~36 s before the first byte) | 70 s | 72 s |
| Images decoded | 347 | 2 (337 recognised without decoding) |
| Map suggestions | 13.1 s | 0.5 s (313 cached readings) |

The download is the floor: Google builds the export, then sends it at about 2.7 MB/s, and parsing keeps pace
with it. The zip, docx and html exports fail on a doc this size (HTTP 413 or timeout), which is why the job
streams Markdown.

## Privacy and safety

- Each browser gets an anonymous id cookie, and jobs, images and progress are only visible to the browser that
  started them.
- Image links inside a doc are fetched only over https from public hosts; private and local addresses are refused.
- Jobs older than 30 days are deleted, and stored images no job uses are removed.
- A Discord webhook address, if used, stays in the browser tab and is never stored.

## Run it

```bash
npm install
npm run build
npm start          # http://localhost:3000
npm test           # parser, matching and link tests
```

Without `DATABASE_URL` it uses an embedded PGlite database in `data/`; without an Object Storage bucket it
stores images in `data/blobs/`.

## On Replit

1. Add a **PostgreSQL database** (sets `DATABASE_URL`).
2. Add **App Storage** (Object Storage) so images survive redeploys (sets `REPLIT_DEFAULT_BUCKET_ID`).
3. Set `SAMPLE_DOC_URL` to the public sample doc to show "Use the Sample Doc".
4. Publish as a **Reserved VM**: jobs keep running after the request that started them, which Autoscale pauses.

## What I wrote, and what AI wrote

I designed the product, chose the task, supplied the real doc and checked every result against it. The code
was written with Claude (Anthropic) as a pair programmer, from my direction: the Markdown-export approach, the
streaming parser, the map reader and the interface were each tested against my real doc before being kept.
