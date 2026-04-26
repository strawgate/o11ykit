//! Parse stdin one line per log message, run the in-house Drain port,
//! and emit one cluster ID per line on stdout. Used by the Python
//! validation harness as a sidecar process.
//!
//! Args:
//!   --depth N --sim-th-bp N --max-children N --no-numeric
//! Defaults match Drain3 (depth=4, sim_th=0.4 → 4000 bp, max_children=100,
//! parametrize_numeric_tokens=true).
//!
//! On EOF we emit a final line `# templates=N`. The host parses lines
//! that don't start with `#` as integers (cluster IDs).

use o11y_drain::{Config, Drain};
use std::io::{self, BufRead, Write};

fn main() {
    let mut depth = 4u32;
    let mut sim_th_bp = 4000u32;
    let mut max_children = 100u32;
    let mut parametrize_numeric = true;
    let mut emit_templates = false;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--depth" => depth = args.next().expect("--depth N").parse().unwrap(),
            "--sim-th-bp" => sim_th_bp = args.next().expect("--sim-th-bp N").parse().unwrap(),
            "--max-children" => {
                max_children = args.next().expect("--max-children N").parse().unwrap()
            }
            "--no-numeric" => parametrize_numeric = false,
            "--emit-templates" => emit_templates = true,
            other => panic!("unknown arg: {}", other),
        }
    }

    let cfg = Config {
        depth,
        sim_th: (sim_th_bp as f32) / 10_000.0,
        max_children,
        parametrize_numeric_tokens: parametrize_numeric,
    };
    let mut drain = Drain::new(cfg);

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(s) => s,
            Err(_) => break,
        };
        let id = drain.add_line(&line);
        writeln!(out, "{}", id).unwrap();
    }
    if emit_templates {
        // Emit one template per line: `T<id>\t<template>`.
        for cluster in drain.clusters() {
            let t = drain
                .template_string(cluster_index_for(&drain, cluster.id()))
                .unwrap_or_default();
            writeln!(out, "T{}\t{}", cluster.id(), t).unwrap();
        }
    }
    writeln!(out, "# templates={}", drain.cluster_count()).unwrap();
}

fn cluster_index_for(drain: &Drain, id: u32) -> usize {
    drain
        .clusters()
        .iter()
        .position(|c| c.id() == id)
        .expect("cluster id present")
}
