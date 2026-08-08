# Running `sense watch` as an OS-managed service

`sense watch` never forks or daemonizes — supervision (start at login, restart on crash,
logging) is the OS's job. Two ready-made setups:

## launchd (macOS)

`~/Library/LaunchAgents/com.sense.watch.plist` (adjust the sense path — `which sense` — and the
config path):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.sense.watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/sense</string>
    <string>watch</string>
    <string>--config</string>
    <string>/path/to/sense.config.json</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/sense-watch.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/sense-watch.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.sense.watch.plist
```

## systemd (Linux)

`~/.config/systemd/user/sense-watch.service`:

```ini
[Unit]
Description=sense watch (frontmatter cache pre-warmer)

[Service]
ExecStart=/usr/local/bin/sense watch --config /path/to/sense.config.json
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now sense-watch.service
```

## Coordination notes

- A second `sense watch` on the same tree refuses to start while another's heartbeat is fresh
  (override with `--force`); check with `sense status`.
- A dead watcher can never cause stale query results — every query reconciles on open. The
  watcher only pre-warms.
