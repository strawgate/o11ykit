SHELL := /bin/bash
NPM ?= npm
BASE_PATH ?= /o11ykit/

.PHONY: install lint format typecheck test test-e2e build check check-release clean clean-all
.PHONY: dev-demo dev-chartjs dev-echarts dev-recharts dev-uplot pages-build

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

check-release:
	$(NPM) run check:release

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
