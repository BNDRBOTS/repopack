# Payload Unpacker · Dual Engine

A single‑file HTML tool that converts a `.txt` payload into a structured `.zip` archive—ready to 
unzip and push directly to GitHub. Every block of code is extracted, filenames are detected or 
inferred, and folders are automatically created to mirror the original project.

## How it works

1. **Upload** a `.txt` payload (or **fetch** one from a remote URL).
2. The engine **isolates code blocks** using dividers, fences, and file‑path headers.
3. When no explicit path is found, **heuristic analysis** guesses the filename and directory 
   (e.g., `server.js`, `src/components/Button.jsx`, `public/index.html`).
4. A `.zip` is generated entirely in your browser—**no server, no data sent anywhere**.

## Key features

- **Zero‑loss extraction** – every byte of the original payload is preserved.
- **Auto‑directory inference** – files are placed in `src/`, `public/`, `tests/`, etc., based on content.
- **Phantom‑file prevention** – never creates empty or single‑line files from stray paths.
- **Binary‑safe** – payloads containing null bytes or non‑text content are treated as binary.
- **Traversal‑safe** – path sanitisation prevents directory traversal attacks.
- **Instant deployment** – open the HTML file locally or serve it behind any static host.

## Usage

1. Open `index.html` in Chrome, Edge, or any modern browser.
2. Use the **Local Payload** tab to select a `.txt` file from your computer.
3. Optionally, use the **Remote Payload** tab to fetch a file from a URL.
4. Click **Download .ZIP** and save the archive.
5. Unzip and drag the folder directly into a new GitHub repository.

## Technical notes

- Built with vanilla JavaScript, JSZip, Three.js, and GSAP.
- All processing is client‑side; your files are never uploaded.
- Works offline after the initial page load (CDN scripts will be cached by the browser).

## License

Provided as‑is for personal and commercial use.
