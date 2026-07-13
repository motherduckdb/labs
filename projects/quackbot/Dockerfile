# Pinned to the exact playwright version in package-lock.json — the image's
# preinstalled Chromium must match the npm package or launch fails.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

# tsx (the runtime) is a devDependency, so install the full tree.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

# controllog appends JSONL under ./logs at runtime; pwuser needs to own it.
RUN mkdir -p logs && chown -R pwuser:pwuser /app
USER pwuser

ENV NODE_ENV=production

CMD ["npm", "start"]
