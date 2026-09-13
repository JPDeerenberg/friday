# Friday web-api — tiny stateless image (~8 MB).
# Build from the REPO ROOT so the magister-core path dependency resolves:
#   docker build -f crates/web-api/Dockerfile -t friday-web-api .
FROM rust:1.94-bookworm AS builder
WORKDIR /build
COPY crates/magister-core crates/magister-core
COPY crates/web-api crates/web-api
WORKDIR /build/crates/web-api
RUN cargo build --release \
  && strip /build/target/release/web-api

# Runtime: scratch is enough — TLS uses bundled webpki roots (see
# magister-core::tls), no system CA store, no shell, no package manager.
FROM scratch
COPY --from=builder /build/target/release/web-api /web-api
# Non-root numeric UID (scratch has no /etc/passwd).
USER 65532:65532
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["/web-api"]
