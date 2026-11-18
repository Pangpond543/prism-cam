// Contract between the Prism Cam app (writer) and prism_vcam.dll (reader, loaded by the Windows camera service).
// Included by both crates with include!().

/// COM class of the virtual camera media source.
pub const VCAM_CLSID: u128 = 0x6B1F4C5E_8A2D_4F7B_9C3E_5D1A2B7E9F40;
pub const VCAM_CLSID_STR: &str = "{6B1F4C5E-8A2D-4F7B-9C3E-5D1A2B7E9F40}";
pub const VCAM_NAME: &str = "Prism Cam";

/// Frame file: [magic u32][width u32][height u32][seq u32] … NV12 pixels from byte 64.
/// A memory-mapped file is used (not a named section) because the camera service runs in another session.
pub const FRAME_MAGIC: u32 = 0x4D43_5250; // "PRCM"
pub const FRAME_HEADER: usize = 64;
pub const FRAME_MAX_PIXELS: usize = 1920 * 1080;
pub const FRAME_FILE_SIZE: usize = FRAME_HEADER + FRAME_MAX_PIXELS * 3 / 2;

pub fn frame_dir() -> std::path::PathBuf {
    let base = std::env::var_os("ProgramData").unwrap_or_else(|| "C:\\ProgramData".into());
    std::path::PathBuf::from(base).join("PrismCam")
}
pub fn frame_path() -> std::path::PathBuf {
    frame_dir().join("frame.bin")
}
