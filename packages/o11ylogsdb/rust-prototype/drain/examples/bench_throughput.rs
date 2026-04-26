//! In-process Drain throughput benchmark. Loads a Loghub corpus
//! (passed as path arg) or generates a synthetic HDFS-shaped corpus
//! and reports lines/sec. This isolates Drain's CPU cost from the
//! stdin/UTF-8 pipeline overhead the Python validation harness sees.

use o11y_drain::{Config, Drain};
use std::fs;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut path: Option<String> = None;
    let mut synthetic: usize = 0;
    let mut iters: usize = 5;
    let mut depth: u32 = 4;
    let mut sim_th_bp: u32 = 4000;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--path" => {
                path = Some(args[i + 1].clone());
                i += 2;
            }
            "--synthetic" => {
                synthetic = args[i + 1].parse().unwrap();
                i += 2;
            }
            "--iters" => {
                iters = args[i + 1].parse().unwrap();
                i += 2;
            }
            "--depth" => {
                depth = args[i + 1].parse().unwrap();
                i += 2;
            }
            "--sim-th-bp" => {
                sim_th_bp = args[i + 1].parse().unwrap();
                i += 2;
            }
            other => panic!("unknown arg: {}", other),
        }
    }

    let lines: Vec<String> = if let Some(p) = path {
        let s = fs::read_to_string(&p).expect("read corpus");
        s.lines().map(|l| l.to_string()).collect()
    } else if synthetic > 0 {
        let states = ["FINALIZED", "RBW", "TEMPORARY"];
        (0..synthetic)
            .map(|i| {
                format!(
                    "PacketResponder {n} for block blk_{x:x} terminating at offset {o} replica state {s}",
                    n = i % 4,
                    x = i.wrapping_mul(31),
                    o = i * 4096,
                    s = states[i % 3],
                )
            })
            .collect()
    } else {
        panic!("either --path or --synthetic required");
    };
    let n = lines.len();
    let cfg = Config {
        depth,
        sim_th: sim_th_bp as f32 / 10_000.0,
        max_children: 100,
        parametrize_numeric_tokens: true,
    };

    // Warm-up.
    {
        let mut drain = Drain::new(cfg.clone());
        for line in &lines {
            drain.add_line(line);
        }
    }

    let mut best_ns: u128 = u128::MAX;
    let mut total_clusters = 0;
    for _ in 0..iters {
        let mut drain = Drain::new(cfg.clone());
        let t0 = Instant::now();
        for line in &lines {
            drain.add_line(line);
        }
        let elapsed = t0.elapsed().as_nanos();
        if elapsed < best_ns {
            best_ns = elapsed;
            total_clusters = drain.cluster_count();
        }
    }

    let secs = best_ns as f64 / 1e9;
    let tput = n as f64 / secs;
    println!(
        "lines={} clusters={} best={:.3}ms throughput={:.0} logs/s",
        n,
        total_clusters,
        best_ns as f64 / 1e6,
        tput,
    );
}
