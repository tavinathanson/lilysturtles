# Lily's Turtles

An interactive 3D web aquarium where guests upload drawings that become swimming turtles. Built for birthday parties, classrooms, or any event where you want a shared creative experience on a big screen.

## How It Works

1. A host displays the **live aquarium** (`/live`) on a TV or projector.
2. Guests visit the **upload page** (`/upload`) on their phones — typically via a QR code printed on a table card that points to the server.
3. Each guest names a turtle, snaps a photo of their drawing, enters the event code, and submits.
4. The drawing appears on a 3D turtle's shell and starts swimming in the aquarium within seconds.

## Features

- **3D aquarium** — Three.js scene with autonomous swimming turtles, coral, kelp, tropical fish, bubbles, and a sandy ocean floor
- **Live updates** — the aquarium polls for new turtles every 3 seconds; no refresh needed
- **Image processing** — uploaded drawings are resized, white backgrounds are removed, and the result is mapped onto the turtle's shell
- **Hero turtle** — a special "Lily's Turtle" with a birthday cake on its shell is always present
- **Gallery** — browse all uploaded drawings at `/gallery`
- **Event code** — simple access control so only invited guests can upload and view

## Quick Start

### Prerequisites

- Node.js (v16 or later recommended)
- npm

### Install and run

```bash
npm install
npm start
```

The server starts on **http://localhost:3000** with the default event code `1234`.

### Environment variables

| Variable     | Default | Description                          |
|-------------|---------|--------------------------------------|
| `PORT`      | `3000`  | HTTP server port                     |
| `EVENT_CODE`| `1234`  | Code guests must enter to upload/view |

Example with custom values:

```bash
EVENT_CODE=8888 PORT=8080 npm start
```

## Pages

| URL        | Purpose                                      |
|-----------|----------------------------------------------|
| `/`       | Redirects to `/live`                          |
| `/live`   | 3D aquarium viewer (enter event code on first visit) |
| `/upload` | Upload form — turtle name, photo, event code  |
| `/gallery`| Grid of all saved drawings                    |

## Testing the Upload Flow

### Option 1: Upload from a browser

1. Start the server:
   ```bash
   npm start
   ```
2. Open **http://localhost:3000/upload** in your browser.
3. Fill in:
   - **Turtle Name** — anything up to 30 characters
   - **Turtle Photo** — pick any image from your device (or snap a photo on mobile)
   - **Turtle Code** — `1234` (the default)
4. Tap **Add My Turtle!**
5. On success you'll be redirected to the aquarium at `/live`, where your turtle will appear swimming with its drawing on its shell.

### Option 2: Upload from a phone via QR code

This is the intended party flow:

1. Start the server on a machine on your local network:
   ```bash
   npm start
   ```
2. Find your machine's local IP (e.g. `192.168.1.42`).
3. Generate a QR code that points to `http://192.168.1.42:3000/upload` using any QR code generator (website, CLI tool, or printed card).
4. Scan the QR code on your phone — it opens the upload page.
5. Enter a turtle name, take a photo of a drawing with your camera, enter the event code (`1234`), and submit.
6. Switch to the aquarium on the big screen (`/live`) and watch the new turtle appear.

> **Tip:** The upload page's file input uses `capture="environment"`, so on mobile it will offer to open the camera directly.

### Option 3: Batch upload with the test script

A shell script is included that uploads 5-10 sample SVG drawings:

```bash
# Make sure the server is running first
./test-turtles.sh        # uploads 5 sample turtles
./test-turtles.sh 10     # uploads 10
```

### Option 4: Upload via curl

```bash
curl -X POST http://localhost:3000/api/upload \
  -F "eventCode=1234" \
  -F "name=TestTurtle" \
  -F "photo=@path/to/drawing.png;type=image/png"
```

## API

### `POST /api/upload`

Multipart form data with fields:
- `eventCode` (string) — must match the server's event code
- `name` (string) — turtle name, 1-30 characters
- `photo` (file) — image file, max 5 MB

Returns `{ success: true, id, name }` on success.

### `GET /api/turtles?eventCode=XXXX&knownIds=a,b,c`

Returns all turtles. Pass comma-separated `knownIds` to skip re-sending image data for turtles the client already has.

## Tech Stack

- **Backend:** Node.js, Express, Multer, Sharp
- **Frontend:** Vanilla HTML/JS, Three.js (via CDN)
- **Storage:** In-memory array (max 30 turtles, FIFO eviction) + PNG files saved to `drawings/`
