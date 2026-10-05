FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY src ./src
# Fly's proxy sits in front, so trust one X-Forwarded-For hop for the idea rate limiter.
# Secrets (ADMIN_TOKEN, any API keys) are set with `fly secrets set`, never here.
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 TRUST_PROXY=1
EXPOSE 8080
CMD ["node", "server/index.js"]
