# Friday web-api — small stateless image (~90 MB on debian-slim).
# Build from the REPO ROOT so the magister-core path dependency resolves:
#   docker build -f crates/web-api/Dockerfile -t friday-web-api .
FROM rust:1.94-bookworm AS builder
WORKDIR /build
# Predictable output path: without a workspace each crate would otherwise
# use its own crates/web-api/target (which broke the strip+COPY below).
ENV CARGO_TARGET_DIR=/build/target
COPY crates/magister-core crates/magister-core
COPY crates/web-api crates/web-api
WORKDIR /build/crates/web-api
RUN cargo build --release \
  && strip /build/target/release/web-api

# Runtime: Debian slim, NOT scratch. The builder links glibc dynamically
# (interpreter /lib64/ld-linux-x86-64.so.2 + libc/libm/libgcc_s — see `ldd`),
# and scratch has no dynamic loader at all, which fails at container start
# with the misleading `exec /web-api: no such file or directory`.
# (A musl static build would allow scratch, but aws-lc-sys C compilation
# under musl is fragile — not worth it for a ~90 MB image on free tiers.)
FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/web-api /web-api
USER nobody:nogroup
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["/web-api"]
