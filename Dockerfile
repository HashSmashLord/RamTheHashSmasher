FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY src ./src
# research/sha256-r32/package/ is the one real committed research candidate
# (time_log2=86) the real pipeline runs for that track -- .dockerignore used to
# exclude the whole research/ tree, so this file was silently missing in every
# production container ("research package file missing: ...claim.json" on
# every sha256-r32 cycle) despite being committed to git the whole time.
COPY research ./research
# The real HashSmash pipeline runner (server/lib/hashsmash.js, RAMHERD_PIPELINE=local)
# shells out to real `git` and `python3` at runtime (workspace handling, the
# organizer's own check/intake scripts) against this vendored copy of their repo.
# Both stay installed, not build-only: purging them after the clone would break
# every real pipeline run. reference/ is git-ignored (never committed), so without
# this the image has no reference/hash-smash at all and every pipeline-eligible
# track falls back to "no real runner". Pinned to a known-good commit rather than
# always-latest, so a redeploy can't silently change what a running RAM is checked
# against.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/* \
  && git clone https://github.com/Layr-Labs/hash-smash.git reference/hash-smash \
  && git -C reference/hash-smash checkout 86f1102ff2d6
# Fly's proxy sits in front, so trust one X-Forwarded-For hop for the idea rate limiter.
# Secrets (ADMIN_TOKEN, any API keys) are set with `fly secrets set`, never here.
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 TRUST_PROXY=1
EXPOSE 8080
CMD ["node", "server/index.js"]
