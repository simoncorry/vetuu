# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Repository status

As of now, this repository contains only the Git metadata directory (`.git`) and no tracked source files or configuration files (e.g., no `README.md`, package manifests, or build/test tooling).

Future agents should re-scan the repository structure before making assumptions about tooling, frameworks, or architecture, as these will only become clear once project files are added.

## Commands

No build, lint, or test tooling is currently discoverable in this repository (no `package.json`, `pyproject.toml`, `go.mod`, `Makefile`, or similar files).

Once tooling is added, agents should:

1. Inspect the root directory for language- or framework-specific manifests (for example: `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Makefile`, `docker-compose.yml`).
2. Infer common commands from those manifests and CI workflows (e.g., `npm test`, `npm run lint`, `pytest`, `go test ./...`, `cargo test`).
3. Update this `WARP.md` with concrete commands for:
   - Full test suite
   - Running a single test or test file
   - Linting / formatting
   - Local development server or application entrypoint

## Architecture and structure

The project structure is not yet defined (no application code, configuration, or documentation files are present beyond `.git`).

When application code is added, agents should:

1. Map the high-level layout (top-level directories like `src/`, `apps/`, `services/`, `backend/`, `frontend/`, etc.).
2. Identify the primary entrypoints (for example: web server startup files, CLIs, or background workers).
3. Summarize the main modules, how they interact, and any clear separation of concerns (e.g., API layer vs. domain logic vs. data access).
4. Capture any framework-specific conventions (e.g., Next.js app routes, Django apps, Rails engines) that are evident from the file structure.

After the codebase is initialized, this section should be rewritten to describe the actual architecture based on the concrete files and directories that exist.
