# Agile in Africa Attendance

A Node.js check-in app with an embedded PostgreSQL-compatible database. There is no separate PostgreSQL server to install or configure. PGlite is installed as an app dependency and stores its database files under `data/attendance`.

## Attendee flow

1. The administrator registers and signs in, then adds attendees with full name, email, phone, and organisation. Profession and other details are optional.
2. The administrator prints the event's entrance QR code.
3. A guest scans it and lands on **Welcome to Agile in Africa 2026**.
4. The guest enters their registered name, reviews the matching saved details, and selects **I'm here · Check in**. If no registration matches, they can choose **Register here**, complete the same attendee fields, then search their name and check in.
5. The app saves the check-in timestamp. The admin overview and guest list show the arrival.

## Run locally

Node.js 20 or later is required. No local PostgreSQL service or Docker is required.

```powershell
npm install
Copy-Item .env.example .env
```

Set a unique `SESSION_SECRET` in `.env` (at least 32 characters). Generate one with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

For local testing, set `APP_URL=http://localhost:3000`, then run:

```powershell
npm run dev
```

Open `http://localhost:3000`. The embedded database is created automatically on first start. Keep the `data/` directory: it contains the admin accounts, guests, check-ins, and sessions.

## DigitalOcean droplet with existing Caddy

The files in [`deploy/checkin`](deploy/checkin) are for this app only. Do not replace the droplet's existing Caddyfile or stop its existing Caddy service; add the app's site block to the existing Caddy configuration so the other projects continue running.

1. Choose a hostname such as `checkin.agileinafrica.com` and point its DNS A record at the droplet.
2. Create the app directory and copy the project files into it:

	```sh
	sudo mkdir -p /opt/checkin
	sudo chown "$USER":"$USER" /opt/checkin
	cd /opt/checkin
	```

	Then install Node.js 20+ on the droplet if it is not already installed, and run `npm ci --omit=dev` in `/opt/checkin`.
3. Create the service account and persistent database directory:

	```sh
	sudo useradd --system --no-create-home --shell /usr/sbin/nologin checkin
	sudo install -d -o checkin -g checkin -m 0750 /opt/checkin/data
	sudo install -d -o root -g checkin -m 0750 /etc/checkin
	```

4. Create `/etc/checkin/checkin.env` with a unique `SESSION_SECRET`, `DATABASE_PATH=/opt/checkin/data/attendance`, and `APP_URL=https://checkin.agileinafrica.com`. Generate the secret with `openssl rand -hex 48`, then save the values with `sudo nano /etc/checkin/checkin.env`. Restrict the file to root and the service group (for example, `sudo chown root:checkin /etc/checkin/checkin.env && sudo chmod 0640 /etc/checkin/checkin.env`).
5. Install [`deploy/checkin/checkin.service`](deploy/checkin/checkin.service) as `/etc/systemd/system/checkin.service`; update `ExecStart` if Node is installed at a different path. Then run `sudo systemctl daemon-reload && sudo systemctl enable --now checkin`.
6. Add the contents of [`deploy/checkin/Caddyfile`](deploy/checkin/Caddyfile) to the existing Caddyfile. Do not replace the file or restart Caddy. Validate and gracefully reload the existing service, for example: `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`.
7. Open `https://checkin.agileinafrica.com` and create the admin account. Add your registered guests.

### Generate the entrance QR

The app generates the QR for you; there is no terminal command or separate QR service. After deploying:

1. Confirm `/etc/checkin/checkin.env` has `APP_URL=https://checkin.agileinafrica.com`, then restart the app with `sudo systemctl restart checkin`.
2. Open `https://checkin.agileinafrica.com` and sign in to the admin account.
3. Select **Entrance QR** from the left navigation. The page creates a QR using `APP_URL` and shows the printable event sign.
4. Select **Print entrance sign** and place the printed sign at the venue entrance.

Scan the QR with a phone before printing many copies. It should open the public Agile in Africa check-in page, not `localhost` or the droplet's IP address. If the URL is wrong, correct `APP_URL`, restart `checkin`, and refresh the QR page.

Keep `/opt/checkin/data` on persistent droplet storage and include it in backups. Deploying new code should not delete this directory.

## Privacy note

The requested name-only lookup displays a matching registration's full saved details. A name does not prove identity, so someone who guesses an attendee's name could see those details. For real personal data, add phone/email OTP or a private check-in PIN before returning the attendee record.