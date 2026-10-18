# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM ghcr.io/openclaw/openclaw@sha256:614004ec2cf2e6095124ea544dc8d950c49306aef445a1fc300b88717e24261a AS gentle-ai-extract

USER root
ARG TARGETOS
ARG TARGETARCH

COPY artifacts/ /artifacts/

RUN case "${TARGETOS}/${TARGETARCH}" in \
      linux/amd64) \
        archive="gentle-ai_4.2.0_linux_amd64.tar.gz"; \
        checksum="552c1642fd10f5d96cfe9bb1cc3b66b30eb47d3074cc7ca0559b598eb086defc"; \
        ;; \
      linux/arm64) \
        archive="gentle-ai_4.2.0_linux_arm64.tar.gz"; \
        checksum="2bebe91b8808ce48d86c4d3700d098e37cb6b0658f196c666d9deeeb7c7c1a7a"; \
        ;; \
      *) \
        echo "unsupported Gentle-AI platform: ${TARGETOS}/${TARGETARCH}" >&2; \
        exit 1; \
        ;; \
    esac \
    && echo "${checksum}  /artifacts/${archive}" | sha256sum --check \
    && mkdir /out \
    && tar --extract --gzip --file "/artifacts/${archive}" --directory /out gentle-ai

FROM ghcr.io/openclaw/openclaw@sha256:614004ec2cf2e6095124ea544dc8d950c49306aef445a1fc300b88717e24261a

COPY --from=gentle-ai-extract /out/gentle-ai /usr/local/bin/gentle-ai

