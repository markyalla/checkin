# Agile in Africa Attendance

A Node.js check-in app with an embedded PostgreSQL-compatible database. There is no separate PostgreSQL server to install or configure. PGlite is installed as an app dependency and stores its database files under `data/attendance`.

## Attendee flow

1. The administrator registers and signs in, then adds attendees with full name, email, phone, and organisation. Profession and other details are optional.
2. The administrator prints the event's entrance QR code.
3. A guest scans it and lands on **Welcome to Agile in Africa 2026**.
4. The guest enters their registered name or 4-digit check-in code, reviews the matching saved details, and selects **Check in for today**. If no registration matches, they can choose **Register here**, complete the same attendee fields, then search their name and check in.
5. The app saves one check-in per guest per day. A second scan on the same day keeps the first arrival time; the guest can check in again on the next event day without registering again.
6. Every guest, whether added by the admin or self-registered, gets a unique, randomly chosen 4-digit check-in code. It appears in the guest list and is shown to the guest when they register or find themselves. On the check-in page a guest can search by full name or by code. Guests without a smartphone tell the code at the desk; staff open **Desk check-in**, type the code, confirm the details, and check them in for today.
7. The admin overview and guest list show arrivals for the day chosen in the top bar, and **Daily check-ins** breaks attendance down day by day.

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

Check-in days roll over at midnight in `EVENT_TIMEZONE` (default `Africa/Accra`); set it to an IANA time zone name if the event is elsewhere.

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

### Deploy updates

The droplet runs the code from a git clone in `/opt/checkin`. After changes are pushed to `main` on GitHub, SSH into the droplet and run:

1. Back up the database. Stop the app first so the copy is consistent:

	```sh
	sudo systemctl stop checkin
	sudo cp -a /opt/checkin/data "/opt/checkin-data-backup-$(date +%Y%m%d-%H%M)"
	```

2. Pull the new code:

	```sh
	cd /opt/checkin
	git pull origin main
	```

3. Install dependencies only if `package.json` or `package-lock.json` changed in the pull:

	```sh
	npm ci --omit=dev
	```

4. Start the app and confirm it is running:

	```sh
	sudo systemctl start checkin
	sudo systemctl status checkin --no-pager
	sudo journalctl -u checkin -n 30 --no-pager
	```

	The log should end with `Gather is running at http://localhost:3000`. Database changes (such as new tables) apply automatically on start.

5. Open the site, sign in, and check the overview loads. The entrance QR does not change between deploys, so printed signs keep working.

If the app fails to start, the log in step 4 says why. To roll back, run `git log --oneline -5`, then `git checkout <previous-commit>`, stop the app, restore the backup over `/opt/checkin/data`, and start it again.

If `/opt/checkin` was first set up by copying files rather than cloning, `git pull` will report it is not a git repository. Convert it once, keeping `data/` in place:

```sh
cd /opt/checkin
git init
git remote add origin https://github.com/markyalla/checkin.git
git fetch origin
git reset --hard origin/main
git branch -M main
git branch --set-upstream-to=origin/main
```

`data/` and `.env` are in `.gitignore`, so git never overwrites or deletes them.

## Privacy note

The requested name-only lookup displays a matching registration's full saved details. A name does not prove identity, so someone who guesses an attendee's name could see those details. For real personal data, add phone/email OTP or a private check-in PIN before returning the attendee record.