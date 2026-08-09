use std::{env, fs, path::Path};

fn copy_file(source_root: &Path, destination_root: &Path, relative: &str) {
    let source = source_root.join(relative);
    let destination = destination_root.join(relative);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).unwrap_or_else(|error| {
            panic!(
                "create ConPTY output directory {}: {error}",
                parent.display()
            )
        });
    }
    fs::copy(&source, &destination).unwrap_or_else(|error| {
        panic!(
            "copy bundled ConPTY {} to {}: {error}",
            source.display(),
            destination.display()
        )
    });
}

fn stage_windows_conpty() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set");
    let vendor_root = Path::new(&manifest_dir).join("../../../crates/ccsm-platform/vendor");
    let source_root = vendor_root.join("conpty");
    let notices_root = vendor_root.join("conpty-notices");
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR is set");
    let profile_dir = Path::new(&out_dir)
        .ancestors()
        .nth(3)
        .expect("OUT_DIR has a Cargo profile ancestor");
    let destination_root = profile_dir.join("conpty");

    for relative in [
        "herdr-conpty.json",
        "conpty.dll",
        "x64/OpenConsole.exe",
        "arm64/OpenConsole.exe",
    ] {
        println!(
            "cargo:rerun-if-changed={}",
            source_root.join(relative).display()
        );
        copy_file(&source_root, &destination_root, relative);
    }

    let notices_destination = profile_dir.join("THIRD-PARTY-NOTICES");
    for relative in [
        "Microsoft.Windows.Console.ConPTY-LICENSE.txt",
        "Microsoft.Windows.Console.ConPTY-NOTICE.md",
    ] {
        println!(
            "cargo:rerun-if-changed={}",
            notices_root.join(relative).display()
        );
        copy_file(&notices_root, &notices_destination, relative);
    }
}

fn main() {
    stage_windows_conpty();
    tauri_build::build();
}
