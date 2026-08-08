# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM ghcr.io/openclaw/openclaw@sha256:6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c AS gentle-ai-extract

USER root
ARG TARGETOS
ARG TARGETARCH

COPY artifacts/ /artifacts/

RUN case "${TARGETOS}/${TARGETARCH}" in \
      linux/amd64) \
        archive="gentle-ai_2.1.11_linux_amd64.tar.gz"; \
        checksum="d115aaf5724a71503150ebf740769e7aa52e41e673ac39bf5b0ff1be4e3324b0"; \
        ;; \
      linux/arm64) \
        archive="gentle-ai_2.1.11_linux_arm64.tar.gz"; \
        checksum="aea3a4b0064b57df5f831fdf6b27b29e9898a8f9393fd648dea4a8ba563e477e"; \
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
