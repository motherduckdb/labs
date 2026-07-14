# Pinned to the exact playwright version in package-lock.json — the image's
# preinstalled Chromium must match the npm package or launch fails. Pinned by
# digest too (not just the mutable tag) so a repushed tag can't change the base
# out from under a rebuild; bump both together when upgrading playwright.
FROM mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48

WORKDIR /app

# Runtime deps only. tsx (the runtime) lives in "dependencies", so --omit=dev
# still installs it while dropping the build/test tree (typescript, vitest,
# @types) from the production image — shrinking the attack surface. eslint +
# eslint-plugin-react-hooks stay in "dependencies" because dive-linter.ts
# imports them at runtime.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

# controllog appends JSONL under ./logs at runtime; pwuser needs to own it.
RUN mkdir -p logs && chown -R pwuser:pwuser /app
USER pwuser

ENV NODE_ENV=production

CMD ["npm", "start"]
