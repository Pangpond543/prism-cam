// Exercises the media source in-process (no camera service, no registration): class factory → activate →
// source reader → a few NV12 frames. Run with `cargo test -p prism-vcam`.
use std::ffi::c_void;
use windows::core::{Interface, GUID};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, IClassFactory, COINIT_MULTITHREADED};

#[test]
fn source_delivers_frames() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(0x0002_0070, MFSTARTUP_FULL).unwrap();
        let clsid = GUID::from_u128(0x6B1F4C5E_8A2D_4F7B_9C3E_5D1A2B7E9F40);
        let mut p: *mut c_void = std::ptr::null_mut();
        prism_vcam::DllGetClassObject(&clsid, &IClassFactory::IID, &mut p).ok().unwrap();
        let factory = IClassFactory::from_raw(p);
        let act: IMFActivate = factory.CreateInstance(None).unwrap();
        assert!(act.GetUINT32(&MF_VIRTUALCAMERA_PROVIDE_ASSOCIATED_CAMERA_SOURCES).is_err());
        let src: IMFMediaSourceEx = act.ActivateObject().unwrap();
        let attrs = src.GetSourceAttributes().unwrap();
        assert!(attrs.GetCount().unwrap() >= 2);
        let sattrs = src.GetStreamAttributes(0).unwrap();
        assert_eq!(sattrs.GetUINT32(&MF_DEVICESTREAM_FRAMESERVER_SHARED).unwrap(), 1);

        let reader = MFCreateSourceReaderFromMediaSource(&src, None).unwrap();
        reader.SetStreamSelection(0xFFFF_FFFC, true).unwrap();
        let ty = reader.GetCurrentMediaType(0xFFFF_FFFC).unwrap();
        let size = ty.GetUINT64(&MF_MT_FRAME_SIZE).unwrap();
        let (w, h) = ((size >> 32) as u32, size as u32);
        println!("negotiated {w}x{h}");
        let t0 = std::time::Instant::now();
        let mut got = 0;
        for _ in 0..12 {
            let (mut flags, mut ts, mut sample) = (0u32, 0i64, None);
            reader.ReadSample(0xFFFF_FFFC, 0, None, Some(&mut flags), Some(&mut ts), Some(&mut sample)).unwrap();
            if let Some(s) = sample {
                let buf = s.ConvertToContiguousBuffer().unwrap();
                let len = buf.GetCurrentLength().unwrap();
                assert_eq!(len, w * h * 3 / 2, "NV12 frame size");
                got += 1;
            }
        }
        let ms = t0.elapsed().as_millis();
        println!("{got} frames in {ms} ms");
        assert!(got >= 10);
        assert!(ms > 250, "frames must be paced (~30 fps), took {ms} ms");
        src.Shutdown().unwrap();
    }
}
