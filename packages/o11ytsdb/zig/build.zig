const std = @import("std");

pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{});

    const lib = b.addSharedLibrary(.{
        .name = "o11ytsdb",
        .root_source_file = b.path("src/root.zig"),
        .target = b.resolveTargetQuery(.{
            .cpu_arch = .wasm32,
            .os_tag = .freestanding,
        }),
        .optimize = optimize,
    });

    // Strip debug info for smallest binary.
    lib.root_module.strip = optimize != .Debug;

    // Export WASM memory so JS can read/write buffers.
    lib.export_memory = true;
    lib.initial_memory = 256 * 65536; // 16 MB
    lib.max_memory = 1024 * 65536; // 64 MB

    b.installArtifact(lib);

    // Unit tests (native target for development).
    const unit_tests = b.addTest(.{
        .root_source_file = b.path("src/root.zig"),
        .optimize = optimize,
    });

    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_unit_tests.step);
}
