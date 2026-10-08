set shell := ["bash", "-uc"]

# Show all available commands
default:
    @just --list

# Install dependencies and setup development environment
dev-install:
    bun install --frozen-lockfile

# Format code (auto-fix)
format:
    bun run format

# Check formatting without writing
format-check:
    bun run format:check

# Lint code (auto-fix, complexity threshold=10)
lint:
    bun run lint

# Lint code without writing
lint-check:
    bun run lint:check

# Type check code
typecheck:
    bun run typecheck

# Run unit tests
test:
    bun test

# Run unit tests with coverage threshold
coverage:
    bun test --coverage

# Validate repository skill metadata and discovery links
repository-skills:
    ./scripts/repository-skills.sh

# Build the fffactory executable for this host, or for the named targets (darwin-arm64, linux-x64)
build *targets:
    bun scripts/build.ts {{targets}}

# Build both release targets into dist/
build-all:
    bun scripts/build.ts darwin-arm64 linux-x64

# Build the linux-x64 executable and smoke-test it in a clean container (needs Docker and jq)
smoke:
    bun scripts/build.ts linux-x64
    ./scripts/smoke-test.sh dist/fffactory-linux-x64

# Check the Terraform modules with the managed Terraform: fmt, validate, namespacing plans (downloads Terraform and the AWS provider)
terraform-check:
    bun scripts/terraform-check.ts

# Test the worker bootstrap (user data and root activator) in Amazon Linux 2023 containers (needs Docker)
bootstrap-test *cases:
    ./scripts/bootstrap-test.sh {{cases}}

# Run all quality checks (format, lint, typecheck, coverage - fastest first)
check-all: format-check lint-check typecheck coverage repository-skills
    @echo "All checks passed"

# Remove generated files and artifacts
clean:
    rm -rf node_modules dist coverage
