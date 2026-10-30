FROM ghcr.io/senorsen/openclaw-fork@sha256:6069b17e4a57a23568f92bdf3b36fa5503c5dcbb5ab24e7034f606bf3c07e181
USER root
COPY --chown=node:node . /opt/compaction-fix-20261030/
RUN node /opt/compaction-fix-20261030/patch.mjs /app --runtime-overlay
USER node
RUN node /opt/compaction-fix-20261030/verify.mjs /app
