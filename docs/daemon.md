# Running it as a service

The core app never calls `launchctl` / `systemctl`; process supervision is left to the platform.
Pick the block for your OS and adjust the absolute paths.

## macOS (launchd)

`~/Library/LaunchAgents/io.example.douyin-forwarder.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.example.douyin-forwarder</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/ABSOLUTE/PATH/douyin-forwarder/src/index.js</string>
    <string>schedule</string>
  </array>
  <key>WorkingDirectory</key><string>/ABSOLUTE/PATH/douyin-forwarder</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/ABSOLUTE/PATH/douyin-forwarder/data/service.log</string>
  <key>StandardErrorPath</key><string>/ABSOLUTE/PATH/douyin-forwarder/data/service.err.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.example.douyin-forwarder.plist
launchctl print gui/$(id -u)/io.example.douyin-forwarder | head
```

## Linux (systemd --user)

`~/.config/systemd/user/douyin-forwarder.service`

```ini
[Unit]
Description=Douyin forwarder
After=network-online.target

[Service]
WorkingDirectory=/ABSOLUTE/PATH/douyin-forwarder
ExecStart=/usr/bin/node /ABSOLUTE/PATH/douyin-forwarder/src/index.js schedule
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now douyin-forwarder
journalctl --user -u douyin-forwarder -f
```

## Windows

Use Task Scheduler with "At log on" + "Restart on failure", running
`node src\index.js schedule` with the project folder as the working directory.

## Notes

- These services run with a GUI-less session on some setups; the browser needs a desktop session
  to show the persistent profile window. If your service runs at boot before login, either log in
  first or run the browser headless (`BROWSER_HEADLESS=true`) — note that Douyin's anti-bot is more
  aggressive against headless sessions.
- Closing the lid on a laptop may still suspend the process; that is an OS power policy, not an
  app concern (see the project notes about `SleepDisabled`).
