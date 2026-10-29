fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=proto/mori.proto");
    if std::env::var("PROTOC").is_err() {
        let winget_protoc = std::path::PathBuf::from(
            r"C:\Users\Administrator\AppData\Local\Microsoft\WinGet\Packages\Google.Protobuf_Microsoft.Winget.Source_8wekyb3d8bbwe\bin\protoc.exe",
        );
        if winget_protoc.exists() {
            unsafe {
                std::env::set_var("PROTOC", &winget_protoc);
            }
        }
    }
    tonic_build::compile_protos("proto/mori.proto")?;
    Ok(())
}
