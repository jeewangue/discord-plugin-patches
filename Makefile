PLUGIN_VERSION ?= 0.0.4
PLUGIN_DIR ?= $(HOME)/.claude/plugins/cache/claude-plugins-official/discord/$(PLUGIN_VERSION)

.PHONY: help install test build apply check-drift verify-apply check-deps check-deps-warn typecheck clean ci

help:
	@echo "Targets:"
	@echo "  make install       bun install"
	@echo "  make test          bun test lib/"
	@echo "  make build         bundle server.ts to dist/server.bundle.js (sanity check)"
	@echo "  make apply         copy server.ts + runtime lib/*.ts onto $(PLUGIN_DIR)"
	@echo "  make check-drift   diff server.ts + lib/ against the installed plugin"
	@echo "  make verify-apply  clean-room smoke: apply into mktemp, assert imports resolve"
	@echo "  make check-deps    assert deployed imports are declared in plugin package.json"
	@echo "  make typecheck     bun x tsc --noEmit (warns on pre-existing errors)"
	@echo "  make ci            install + test + build + check-drift + verify-apply"
	@echo "  make clean         remove dist/"
	@echo ""
	@echo "Override PLUGIN_VERSION / PLUGIN_DIR if your install differs."

test:
	bun test lib/

ci: install test build check-drift verify-apply check-deps-warn

check-deps-warn:
	@PLUGIN_DIR="$(PLUGIN_DIR)" PLUGIN_VERSION="$(PLUGIN_VERSION)" bun run scripts/check-deps.ts || \
		echo "warning: check-deps reported drift (non-fatal in ci; see README accepted-risk)"

install:
	bun install

build:
	@mkdir -p dist
	bun build --target=node --outfile=dist/server.bundle.js server.ts
	@echo "built dist/server.bundle.js (use only as a syntax sanity check; apply ships server.ts)"

apply:
	@PLUGIN_DIR="$(PLUGIN_DIR)" PLUGIN_VERSION="$(PLUGIN_VERSION)" bash scripts/apply.sh

check-drift:
	@PLUGIN_DIR="$(PLUGIN_DIR)" PLUGIN_VERSION="$(PLUGIN_VERSION)" bash scripts/check-drift.sh

verify-apply:
	@PLUGIN_DIR="$(PLUGIN_DIR)" PLUGIN_VERSION="$(PLUGIN_VERSION)" bash scripts/verify-apply.sh

check-deps:
	@PLUGIN_DIR="$(PLUGIN_DIR)" PLUGIN_VERSION="$(PLUGIN_VERSION)" bun run scripts/check-deps.ts

typecheck:
	bun x tsc --noEmit

clean:
	rm -rf dist
