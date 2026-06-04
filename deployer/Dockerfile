# Build stage
FROM golang:1.22-alpine AS builder

RUN apk add --no-cache git ca-certificates
WORKDIR /build
COPY go.mod .
RUN go mod download
COPY server.go .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o deployer .

# Runtime — minimal + Docker CLI
FROM alpine:3.19

RUN apk add --no-cache docker-cli curl ca-certificates tzdata

COPY --from=builder /build/deployer /usr/local/bin/deployer

EXPOSE 9090

# Default flags — override via docker-compose environment
ENTRYPOINT ["deployer"]
CMD [
  "-port=9090",
  "-projects-dir=/opt/projects",
]
