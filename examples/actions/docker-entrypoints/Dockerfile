FROM alpine:3.20

WORKDIR /github/action
COPY pre-entrypoint.sh entrypoint.sh post-entrypoint.sh ./
RUN chmod +x pre-entrypoint.sh entrypoint.sh post-entrypoint.sh
