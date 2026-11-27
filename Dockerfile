FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    TZ=Asia/Shanghai \
    DATA_DIR=/app/data \
    DB_FILE=/app/data/app.db \
    SHOTS_DIR=/app/data/shots \
    DASH_HOST=0.0.0.0 \
    DASH_PORT=9400 \
    BROWSER_CHANNEL=chromium \
    BROWSER_HEADLESS=false \
    BROWSER_POS=0,0 \
    BROWSER_VISIBLE_POS=0,0 \
    BROWSER_MINIMIZE_ON_START=false \
    BROWSER_NO_SANDBOX=true \
    BROWSER_DISABLE_DEV_SHM=true \
    HOST_LOG_STDOUT=1 \
    DISPLAY=:99 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# tini: proper PID 1 signal forwarding & zombie reaping
# xvfb: virtual display so Chromium runs in headed mode without a physical desktop
# fonts-noto-cjk: Chinese font rendering for Douyin pages and screenshot viewer
# tzdata: ensures Asia/Shanghai (or user-overridden TZ) scheduling timestamps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-noto-cjk \
    tini \
    tzdata \
    xvfb \
  && ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime \
  && echo "$TZ" > /etc/timezone \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && node node_modules/playwright-core/cli.js install chromium --with-deps \
  && chmod -R a+rX /ms-playwright \
  && rm -rf /var/lib/apt/lists/* /root/.npm

COPY src ./src
COPY schema ./schema
COPY app/viewer.html ./app/viewer.html
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x /app/docker-entrypoint.sh \
  && mkdir -p /app/data

VOLUME ["/app/data"]
EXPOSE 9400

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.DASH_PORT || 9400) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "src/index.js", "host"]
