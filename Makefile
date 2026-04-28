SHELL := /bin/bash
NPM ?= npm
BASE_PATH ?= /o11ykit/otlpkit/

.PHONY: install lint format typecheck site-typecheck test test-fast test-e2e build check check-release check-all clean clean-all
.PHONY: dev-demo dev-chartjs dev-echarts dev-recharts dev-uplot pages-build
.PHONY: octo11y-install octo11y-lint octo11y-test octo11y-build octo11y-check
.PHONY: knip

install:
	$(NPM) ci

lint:
	$(NPM) run lint

format:
	$(NPM) run format

typecheck:
	$(NPM) run typecheck

site-typecheck:
	$(NPM) run typecheck:site

test:
	$(NPM) run test

# Fast unit tests (no coverage, no E2E)
test-fast:
	npx vitest run --no-coverage

test-e2e:
	$(NPM) run test:e2e

build:
	$(NPM) run build

# Dead code / unused export analysis
knip:
	npx knip

check:
	$(NPM) run check

check-all:
	$(NPM) run check:all

check-release:
	$(NPM) run check:release

octo11y-install:
	$(NPM) run octo11y:install

octo11y-lint:
	$(NPM) run octo11y:lint

octo11y-test:
	$(NPM) run octo11y:test

octo11y-build:
	$(NPM) run octo11y:build

octo11y-check:
	$(NPM) run octo11y:check

clean:
	$(NPM) run clean

clean-all:
	$(NPM) run clean:all

dev-demo:
	$(NPM) run dev:demo

dev-chartjs:
	$(NPM) run dev:chartjs

dev-echarts:
	$(NPM) run dev:echarts

dev-recharts:
	$(NPM) run dev:recharts

dev-uplot:
	$(NPM) run dev:uplot

pages-build:
	BASE_PATH=$(BASE_PATH) $(NPM) run build --workspace @otlpkit/example-demo
	BASE_PATH=/o11ykit/logsdb-engine/ npx vite build site/logsdb-engine
	BASE_PATH=/o11ykit/tracesdb-engine/ npx vite build site/tracesdb-engine
	BASE_PATH=/o11ykit/tsdb-engine/ npx vite build site/tsdb-engine
	rm -rf .site
	mkdir -p .site/otlpkit
	cp -R site/* .site/
	rm -rf .site/logsdb-engine/js .site/logsdb-engine/dist
	cp -R site/logsdb-engine/dist/* .site/logsdb-engine/
	rm -rf .site/tracesdb-engine/js .site/tracesdb-engine/dist
	cp -R site/tracesdb-engine/dist/* .site/tracesdb-engine/
	rm -rf .site/tsdb-engine/js .site/tsdb-engine/dist
	cp -R site/tsdb-engine/dist/* .site/tsdb-engine/
	cp -R examples/demo/dist/* .site/otlpkit/
