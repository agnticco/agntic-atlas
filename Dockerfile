# Atlas — build automations by talking.
#
# Two stages. The first has a compiler toolchain, because `better-sqlite3` and
# `argon2` are native modules; the second has none of it, so the image you actually
# run is not carrying a C++ compiler around.
#
# `node-llama-cpp` (local models) is an OPTIONAL dependency and is deliberately
# NOT installed here — it is a large native build, almost nobody self-hosting wants
# it, and Atlas runs against Anthropic or OpenAI without it. If you do want local
# models, build with:  docker build --build-arg INSTALL_LOCAL_MODELS=1 .

# ── Stage 1: install dependencies ────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps

# python3/make/g++ are needed to compile better-sqlite3 and argon2. They exist only
# in this stage and never reach the final image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only the manifests first, so this layer is cached and dependencies are not
# reinstalled every time a source file changes.
COPY package.json package-lock.json ./

ARG INSTALL_LOCAL_MODELS=0
RUN if [ "$INSTALL_LOCAL_MODELS" = "1" ]; then \
      npm ci --include=optional; \
    else \
      npm ci --omit=optional; \
    fi

# ── Stage 2: the image that actually runs ────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# tini gives us a real init: it reaps zombies and, more importantly, forwards
# SIGTERM so `docker stop` shuts Atlas down cleanly instead of killing it mid-write
# on a SQLite database.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public
COPY release-notes.json ./release-notes.json

# Atlas keeps every SQLite database, encryption key and uploaded document under
# ./memory. It MUST be a volume — without one, `docker rm` destroys the accounts,
# the workflows and the OAuth key that decrypts stored tokens, with no warning.
RUN mkdir -p /app/memory && chown -R node:node /app
VOLUME ["/app/memory"]

# Never run as root. `node` is an unprivileged user the base image already provides.
USER node

EXPOSE 3000

# Atlas serves /health unauthenticated for exactly this purpose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/api/server.js"]
