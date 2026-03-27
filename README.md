# Float

Float is a self-hosted shared transfer room built around one giant animated bubble. You unlock it with a shared password, drop files or paste text into the bubble, and those items float live across devices until the room policy removes them or someone clears them.

## What it does

- Full-screen bubble room with dark, light, and auto theme support
- Desktop drag and drop plus direct paste for copied text
- Mobile-friendly tap flow for file upload or text paste
- Password-gated room entry with password-confirmed settings modal
- Persistent disk-backed storage for files and pasted text
- Live cross-device sync with WebSockets
- Lifetime modes for keep until deleted, delete on first download, or timed expiry
- Share link and QR card in settings
- Linux `systemd` installer with custom port prompt

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a runtime config:

   ```bash
   FLOAT_PASSWORD="your-password" npm run init-config -- \
     --bind-host 0.0.0.0 \
     --port 3000 \
     --public-base-url http://localhost:3000 \
     --storage-path ./storage
   ```

3. Start the server:

   ```bash
   npm start
   ```

4. Open the app in your browser and enter the shared password.

## Installer

Run the guided installer on Linux:

```bash
chmod +x install.sh
./install.sh
```

It prompts for:

- bind host
- port
- public base URL
- storage path
- shared password
- `systemd` service user

The installer writes `config/runtime.json`, installs dependencies, creates a `float.service` unit, and starts it when `systemd` is available.

## Scripts

- `npm start` starts the Float server
- `npm test` runs the automated server tests
- `npm run init-config -- ...` writes a hashed runtime config

## Notes

- Runtime config is intentionally not committed and lives at `config/runtime.json`
- For public internet use, put Float behind HTTPS with a reverse proxy
- The server targets Node.js 18 or newer
