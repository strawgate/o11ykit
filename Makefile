SHELL := /bin/bash
NPM ?= npm
BASE_PATH ?= /o11ykit/otlpkit/

.PHONY: install lint format typecheck test test-e2e build check check-release check-all clean clean-all
.PHONY: dev-demo dev-chartjs dev-echarts dev-recharts dev-uplot pages-build
.PHONY: octo11y-install octo11y-lint octo11y-test octo11y-build octo11y-check

install:
	$(NPM) ci

lint:
	$(NPM) run lint

format:
	$(NPM) run format

typecheck:
	$(NPM) run typecheck

test:
	$(NPM) run test

test-e2e:
	$(NPM) run test:e2e

build:
	$(NPM) run build

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
	rm -rf .site
	mkdir -p .site/otlpkit
	cp -R site/* .site/
	cp -R examples/demo/dist/* .site/otlpkit/
