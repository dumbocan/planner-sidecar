# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM ghcr.io/openclaw/openclaw@sha256:6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c AS gentle-ai-extract

USER root
ARG TARGETOS
ARG TARGETARCH

COPY artifacts/ /artifacts/

RUN case "${TARGETOS}/${TARGETARCH}" in \
      linux/amd64) \
        archive="gentle-ai_2.3.0_linux_amd64.tar.gz"; \
        checksum="899d3382c39c4095d7830def523e27a78aa94c410e63e36a7aa702a186f43f99"; \
        ;; \
      linux/arm64) \
        archive="gentle-ai_2.3.0_linux_arm64.tar.gz"; \
        checksum="d3385c41094b7a53cc4d96132b86822bcacd0cd06bb5b58ab2a592c45bb827d8"; \
        ;; \
      *) \
        echo "unsupported Gentle-AI platform: ${TARGETOS}/${TARGETARCH}" >&2; \
        exit 1; \
        ;; \
    esac \
    && echo "${checksum}  /artifacts/${archive}" | sha256sum --check \
    && mkdir /out \
    && tar --extract --gzip --file "/artifacts/${archive}" --directory /out gentle-ai

FROM ghcr.io/openclaw/openclaw@sha256:6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c

COPY --from=gentle-ai-extract /out/gentle-ai /usr/local/bin/gentle-ai

RUN npm install --prefix /home/node/.local gga

ENV PATH="/home/node/.local/bin:${PATH}"
