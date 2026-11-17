# Railway worker. Build context is the repo root (services/ reads ../deployments and ../sdk).
# Deploys automatically on push to main when services/, sdk/ or deployments/ change (Railway watch paths).
FROM oven/bun:1.3
WORKDIR /app
COPY deployments ./deployments
# sdk/ is imported from source by the worker; it needs its own viem. Lockfiles are enforced (frozen) for both.
COPY sdk/package.json sdk/bun.lock ./sdk/
RUN cd sdk && bun install --production --frozen-lockfile
COPY sdk/src ./sdk/src
COPY services/package.json services/bun.lock ./services/
RUN cd services && bun install --production --frozen-lockfile
COPY services/src ./services/src
WORKDIR /app/services
USER bun
CMD ["bun", "src/index.ts"]
