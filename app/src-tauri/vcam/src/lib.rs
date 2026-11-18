// prism_vcam.dll — the "Prism Cam" virtual camera for Windows 11.
//
// Windows' camera service (Frame Server) loads this COM server and asks it for a Media Foundation media source.
// The source has one NV12 video stream; every requested frame is copied from the memory-mapped frame file that
// the Prism Cam app keeps writing (see ../../src/shared.rs). When the app is not sending, a calm idle frame is shown.
#![allow(non_snake_case, clippy::missing_safety_doc)]

use std::ffi::c_void;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows::core::{implement, w, AsImpl, Error, IUnknown, Interface, Ref, Result, BOOL, GUID, HRESULT, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_FAIL, E_INVALIDARG, E_POINTER, HANDLE, S_FALSE, S_OK};
use windows::Win32::Media::KernelStreaming::{IKsControl, IKsControl_Impl, KSCAMERAPROFILE_Legacy, KSIDENTIFIER, PINNAME_VIDEO_CAPTURE};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl};
use windows::Win32::System::Memory::{CreateFileMappingW, MapViewOfFile, FILE_MAP_READ, PAGE_READONLY};

include!("../../src/shared.rs");

const FPS: u32 = 30;
const FRAME_TICKS: i64 = 10_000_000 / FPS as i64; // 100 ns units
const SIZES: [(u32, u32); 3] = [(1280, 720), (1920, 1080), (640, 360)];
const NOT_FOUND: HRESULT = HRESULT(0x8007_0492_u32 as i32); // HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND)
const NV12: u32 = 0x3231_564E;

/* ------------------------------------------------------------------ COM entry points */
#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(rclsid: *const GUID, riid: *const GUID, ppv: *mut *mut c_void) -> HRESULT {
    if ppv.is_null() || rclsid.is_null() || riid.is_null() { return E_POINTER; }
    *ppv = std::ptr::null_mut();
    if *rclsid != GUID::from_u128(VCAM_CLSID) { return CLASS_E_CLASSNOTAVAILABLE; }
    let factory: IClassFactory = Factory.into();
    factory.query(riid, ppv)
}
#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT { S_FALSE } // stay loaded; the service owns our lifetime

#[implement(IClassFactory)]
struct Factory;
impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(&self, outer: Ref<'_, IUnknown>, riid: *const GUID, ppv: *mut *mut c_void) -> Result<()> {
        if ppv.is_null() { return Err(E_POINTER.into()); }
        if outer.is_some() { return Err(CLASS_E_NOAGGREGATION.into()); }
        let act: IMFActivate = Activator::new()?.into();
        unsafe { act.query(riid, ppv).ok() }
    }
    fn LockServer(&self, _lock: BOOL) -> Result<()> { Ok(()) }
}

fn new_attrs() -> Result<IMFAttributes> {
    let mut a = None;
    unsafe { MFCreateAttributes(&mut a, 8)?; }
    a.ok_or_else(|| Error::from(E_FAIL))
}

/* ------------------------------------------------------------------------- activator */
#[implement(IMFActivate)]
struct Activator { attrs: IMFAttributes, source: Mutex<Option<IMFMediaSourceEx>> }
impl Activator {
    fn new() -> Result<Self> {
        let attrs = new_attrs()?;
        unsafe {
            // NOTE: do not set MF_VIRTUALCAMERA_PROVIDE_ASSOCIATED_CAMERA_SOURCES — it makes Frame Server open the physical cameras
            // for us and lock them, so apps (including Prism Cam itself) could no longer open their own webcam.
            attrs.SetGUID(&MFT_TRANSFORM_CLSID_Attribute, &GUID::from_u128(VCAM_CLSID))?;
        }
        Ok(Self { attrs, source: Mutex::new(None) })
    }
}
impl IMFActivate_Impl for Activator_Impl {
    fn ActivateObject(&self, riid: *const GUID, ppv: *mut *mut c_void) -> Result<()> {
        if ppv.is_null() { return Err(E_POINTER.into()); }
        unsafe { *ppv = std::ptr::null_mut(); }
        let mut slot = self.source.lock().unwrap();
        if slot.is_none() { *slot = Some(Source::create(&self.attrs)?); }
        unsafe { slot.as_ref().unwrap().query(riid, ppv).ok() }
    }
    fn ShutdownObject(&self) -> Result<()> { Ok(()) }
    fn DetachObject(&self) -> Result<()> { *self.source.lock().unwrap() = None; Ok(()) }
}
// IMFActivate is an attribute store: everything is forwarded to a real one
impl IMFAttributes_Impl for Activator_Impl {
    fn GetItem(&self, k: *const GUID, v: *mut PROPVARIANT) -> Result<()> { unsafe { self.attrs.GetItem(k, Some(v)) } }
    fn GetItemType(&self, k: *const GUID) -> Result<MF_ATTRIBUTE_TYPE> { unsafe { self.attrs.GetItemType(k) } }
    fn CompareItem(&self, k: *const GUID, v: *const PROPVARIANT) -> Result<BOOL> { unsafe { self.attrs.CompareItem(k, v) } }
    fn Compare(&self, theirs: Ref<'_, IMFAttributes>, t: MF_ATTRIBUTES_MATCH_TYPE) -> Result<BOOL> { unsafe { self.attrs.Compare(theirs.as_ref(), t) } }
    fn GetUINT32(&self, k: *const GUID) -> Result<u32> { unsafe { self.attrs.GetUINT32(k) } }
    fn GetUINT64(&self, k: *const GUID) -> Result<u64> { unsafe { self.attrs.GetUINT64(k) } }
    fn GetDouble(&self, k: *const GUID) -> Result<f64> { unsafe { self.attrs.GetDouble(k) } }
    fn GetGUID(&self, k: *const GUID) -> Result<GUID> { unsafe { self.attrs.GetGUID(k) } }
    fn GetStringLength(&self, k: *const GUID) -> Result<u32> { unsafe { self.attrs.GetStringLength(k) } }
    fn GetString(&self, k: *const GUID, buf: PWSTR, cch: u32, len: *mut u32) -> Result<()> {
        if buf.is_null() { return Err(E_POINTER.into()); }
        unsafe { self.attrs.GetString(k, std::slice::from_raw_parts_mut(buf.0, cch as usize), if len.is_null() { None } else { Some(len) }) }
    }
    fn GetAllocatedString(&self, k: *const GUID, s: *mut PWSTR, len: *mut u32) -> Result<()> { unsafe { self.attrs.GetAllocatedString(k, s, len) } }
    fn GetBlobSize(&self, k: *const GUID) -> Result<u32> { unsafe { self.attrs.GetBlobSize(k) } }
    fn GetBlob(&self, k: *const GUID, buf: *mut u8, cb: u32, size: *mut u32) -> Result<()> {
        if buf.is_null() { return Err(E_POINTER.into()); }
        unsafe { self.attrs.GetBlob(k, std::slice::from_raw_parts_mut(buf, cb as usize), if size.is_null() { None } else { Some(size) }) }
    }
    fn GetAllocatedBlob(&self, k: *const GUID, buf: *mut *mut u8, size: *mut u32) -> Result<()> { unsafe { self.attrs.GetAllocatedBlob(k, buf, size) } }
    fn GetUnknown(&self, k: *const GUID, riid: *const GUID, ppv: *mut *mut c_void) -> Result<()> {
        type Raw = unsafe extern "system" fn(*mut c_void, *const GUID, *const GUID, *mut *mut c_void) -> HRESULT;
        unsafe { let f: Raw = std::mem::transmute(Interface::vtable(&self.attrs).GetUnknown); f(self.attrs.as_raw(), k, riid, ppv).ok() }
    }
    fn SetItem(&self, k: *const GUID, v: *const PROPVARIANT) -> Result<()> { unsafe { self.attrs.SetItem(k, v) } }
    fn DeleteItem(&self, k: *const GUID) -> Result<()> { unsafe { self.attrs.DeleteItem(k) } }
    fn DeleteAllItems(&self) -> Result<()> { unsafe { self.attrs.DeleteAllItems() } }
    fn SetUINT32(&self, k: *const GUID, v: u32) -> Result<()> { unsafe { self.attrs.SetUINT32(k, v) } }
    fn SetUINT64(&self, k: *const GUID, v: u64) -> Result<()> { unsafe { self.attrs.SetUINT64(k, v) } }
    fn SetDouble(&self, k: *const GUID, v: f64) -> Result<()> { unsafe { self.attrs.SetDouble(k, v) } }
    fn SetGUID(&self, k: *const GUID, v: *const GUID) -> Result<()> { unsafe { self.attrs.SetGUID(k, v) } }
    fn SetString(&self, k: *const GUID, v: &PCWSTR) -> Result<()> { unsafe { self.attrs.SetString(k, *v) } }
    fn SetBlob(&self, k: *const GUID, buf: *const u8, cb: u32) -> Result<()> {
        if buf.is_null() { return Err(E_POINTER.into()); }
        unsafe { self.attrs.SetBlob(k, std::slice::from_raw_parts(buf, cb as usize)) }
    }
    fn SetUnknown(&self, k: *const GUID, v: Ref<'_, IUnknown>) -> Result<()> { unsafe { self.attrs.SetUnknown(k, v.as_ref()) } }
    fn LockStore(&self) -> Result<()> { unsafe { self.attrs.LockStore() } }
    fn UnlockStore(&self) -> Result<()> { unsafe { self.attrs.UnlockStore() } }
    fn GetCount(&self) -> Result<u32> { unsafe { self.attrs.GetCount() } }
    fn GetItemByIndex(&self, i: u32, k: *mut GUID, v: *mut PROPVARIANT) -> Result<()> { unsafe { self.attrs.GetItemByIndex(i, k, Some(v)) } }
    fn CopyAllItems(&self, dest: Ref<'_, IMFAttributes>) -> Result<()> { unsafe { self.attrs.CopyAllItems(dest.as_ref()) } }
}

/* ---------------------------------------------------------------------------- source */
fn time_variant() -> std::mem::ManuallyDrop<PROPVARIANT> {
    // VT_I8 holding the current MF system time
    let mut pv = std::mem::ManuallyDrop::new(PROPVARIANT::default());
    unsafe {
        let p = &mut *pv as *mut PROPVARIANT as *mut u8;
        (p as *mut u16).write(20);
        (p.add(8) as *mut i64).write(MFGetSystemTime());
    }
    pv
}

#[implement(IMFMediaSourceEx, IMFGetService, IKsControl)]
struct Source {
    attrs: IMFAttributes,
    queue: IMFMediaEventQueue,
    pd: IMFPresentationDescriptor,
    stream: IMFMediaStream2,
    dead: Mutex<bool>,
}
impl Source {
    fn create(activator_attrs: &IMFAttributes) -> Result<IMFMediaSourceEx> {
        unsafe {
            let attrs = new_attrs()?;
            activator_attrs.CopyAllItems(&attrs)?;
            // camera profile: one legacy profile, any resolution up to 30 fps
            let profiles = MFCreateSensorProfileCollection()?;
            let profile = MFCreateSensorProfile(&KSCAMERAPROFILE_Legacy, 0, PCWSTR::null())?;
            profile.AddProfileFilter(0, w!("((RES==;FRT<=30,1;SUT==))"))?;
            profiles.AddProfile(&profile)?;
            attrs.SetUnknown(&MF_DEVICEMFT_SENSORPROFILE_COLLECTION, &profiles)?;

            let stream: IMFMediaStream2 = Stream::new()?.into();
            let desc = stream.GetStreamDescriptor()?;
            let pd = MFCreatePresentationDescriptor(Some(&[Some(desc)]))?;
            pd.SelectStream(0)?; // a source selects its default stream
            let source: IMFMediaSourceEx = Source { attrs, queue: MFCreateEventQueue()?, pd, stream: stream.clone(), dead: Mutex::new(false) }.into();
            let s: &Stream = stream.as_impl();
            *s.source.lock().unwrap() = Some(source.cast()?);
            Ok(source)
        }
    }
    fn alive(&self) -> Result<()> { if *self.dead.lock().unwrap() { Err(MF_E_SHUTDOWN.into()) } else { Ok(()) } }
    fn stream(&self) -> &Stream { unsafe { self.stream.as_impl() } }
}
impl IMFMediaEventGenerator_Impl for Source_Impl {
    fn GetEvent(&self, flags: MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS) -> Result<IMFMediaEvent> { self.alive()?; unsafe { self.queue.GetEvent(flags.0) } }
    fn BeginGetEvent(&self, cb: Ref<'_, IMFAsyncCallback>, state: Ref<'_, IUnknown>) -> Result<()> { self.alive()?; unsafe { self.queue.BeginGetEvent(cb.as_ref(), state.as_ref()) } }
    fn EndGetEvent(&self, result: Ref<'_, IMFAsyncResult>) -> Result<IMFMediaEvent> { self.alive()?; unsafe { self.queue.EndGetEvent(result.as_ref()) } }
    fn QueueEvent(&self, met: u32, ext: *const GUID, hr: HRESULT, v: *const PROPVARIANT) -> Result<()> { self.alive()?; unsafe { self.queue.QueueEventParamVar(met, ext, hr, v) } }
}
impl IMFMediaSource_Impl for Source_Impl {
    fn GetCharacteristics(&self) -> Result<u32> { Ok(MFMEDIASOURCE_IS_LIVE.0 as u32) }
    fn CreatePresentationDescriptor(&self) -> Result<IMFPresentationDescriptor> { self.alive()?; unsafe { self.pd.Clone() } }
    fn Start(&self, pd: Ref<'_, IMFPresentationDescriptor>, format: *const GUID, _pos: *const PROPVARIANT) -> Result<()> {
        self.alive()?;
        let pd = pd.ok()?;
        unsafe {
            if !format.is_null() && *format != GUID::zeroed() { return Err(E_INVALIDARG.into()); }
            let (mut selected, mut desc) = (BOOL(0), None);
            pd.GetStreamDescriptorByIndex(0, &mut selected, &mut desc)?;
            let desc = desc.ok_or_else(|| Error::from(E_FAIL))?;
            let stream = self.stream();
            let running = stream.state() != MF_STREAM_STATE_STOPPED;
            if selected.as_bool() != running {
                if selected.as_bool() {
                    self.pd.SelectStream(0)?;
                    self.queue.QueueEventParamUnk(MENewStream.0 as u32, &GUID::zeroed(), S_OK, &self.stream)?;
                    let ty = desc.GetMediaTypeHandler()?.GetCurrentMediaType()?;
                    stream.start(Some(&ty))?;
                } else {
                    self.pd.DeselectStream(0)?;
                    stream.stop()?;
                }
            }
            let t = time_variant();
            self.queue.QueueEventParamVar(MESourceStarted.0 as u32, &GUID::zeroed(), S_OK, &*t)
        }
    }
    fn Stop(&self) -> Result<()> {
        self.alive()?;
        unsafe {
            self.stream().stop()?;
            self.pd.DeselectStream(0)?;
            let t = time_variant();
            self.queue.QueueEventParamVar(MESourceStopped.0 as u32, &GUID::zeroed(), S_OK, &*t)
        }
    }
    fn Pause(&self) -> Result<()> { Err(MF_E_INVALID_STATE_TRANSITION.into()) }
    fn Shutdown(&self) -> Result<()> {
        let mut dead = self.dead.lock().unwrap();
        if *dead { return Err(MF_E_SHUTDOWN.into()); }
        *dead = true;
        unsafe { let _ = self.queue.Shutdown(); }
        self.stream().shutdown();
        Ok(())
    }
}
impl IMFMediaSourceEx_Impl for Source_Impl {
    fn GetSourceAttributes(&self) -> Result<IMFAttributes> { Ok(self.attrs.clone()) }
    fn GetStreamAttributes(&self, id: u32) -> Result<IMFAttributes> { if id == 0 { Ok(self.stream().attrs.clone()) } else { Err(E_FAIL.into()) } }
    fn SetD3DManager(&self, _manager: Ref<'_, IUnknown>) -> Result<()> { Ok(()) } // frames are produced on the CPU
}
impl IMFGetService_Impl for Source_Impl {
    fn GetService(&self, _service: *const GUID, _riid: *const GUID, ppv: *mut *mut c_void) -> Result<()> {
        if !ppv.is_null() { unsafe { *ppv = std::ptr::null_mut(); } }
        Err(MF_E_UNSUPPORTED_SERVICE.into())
    }
}
// no camera controls are exposed
impl IKsControl_Impl for Source_Impl {
    fn KsProperty(&self, _p: *const KSIDENTIFIER, _l: u32, _d: *mut c_void, _dl: u32, _r: *mut u32) -> Result<()> { Err(NOT_FOUND.into()) }
    fn KsMethod(&self, _p: *const KSIDENTIFIER, _l: u32, _d: *mut c_void, _dl: u32, _r: *mut u32) -> Result<()> { Err(NOT_FOUND.into()) }
    fn KsEvent(&self, _p: *const KSIDENTIFIER, _l: u32, _d: *mut c_void, _dl: u32, _r: *mut u32) -> Result<()> { Err(NOT_FOUND.into()) }
}

/* ---------------------------------------------------------------------------- stream */
fn video_type(w: u32, h: u32) -> Result<IMFMediaType> {
    unsafe {
        let t = MFCreateMediaType()?;
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        t.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
        t.SetUINT64(&MF_MT_FRAME_SIZE, ((w as u64) << 32) | h as u64)?;
        t.SetUINT32(&MF_MT_DEFAULT_STRIDE, w)?;
        t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        t.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
        t.SetUINT64(&MF_MT_FRAME_RATE, ((FPS as u64) << 32) | 1)?;
        t.SetUINT32(&MF_MT_AVG_BITRATE, w * h * 12 * FPS)?;
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
        t.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        t.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        Ok(t)
    }
}

struct Live { state: MF_STREAM_STATE, w: u32, h: u32, last: Option<Instant>, frames: Frames }
#[implement(IMFMediaStream2, IKsControl)]
struct Stream {
    attrs: IMFAttributes,
    queue: IMFMediaEventQueue,
    desc: IMFStreamDescriptor,
    source: Mutex<Option<IMFMediaSource>>,
    live: Mutex<Live>,
}
impl Stream {
    fn new() -> Result<Self> {
        unsafe {
            let attrs = new_attrs()?;
            attrs.SetGUID(&MF_DEVICESTREAM_STREAM_CATEGORY, &PINNAME_VIDEO_CAPTURE)?;
            attrs.SetUINT32(&MF_DEVICESTREAM_STREAM_ID, 0)?;
            attrs.SetUINT32(&MF_DEVICESTREAM_FRAMESERVER_SHARED, 1)?;
            attrs.SetUINT32(&MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES, MFFrameSourceTypes_Color.0 as u32)?;
            let types: Vec<Option<IMFMediaType>> = SIZES.iter().map(|&(w, h)| video_type(w, h).map(Some)).collect::<Result<_>>()?;
            let desc = MFCreateStreamDescriptor(0, &types)?;
            desc.GetMediaTypeHandler()?.SetCurrentMediaType(types[0].as_ref())?;
            Ok(Self { attrs, queue: MFCreateEventQueue()?, desc, source: Mutex::new(None), live: Mutex::new(Live { state: MF_STREAM_STATE_STOPPED, w: SIZES[0].0, h: SIZES[0].1, last: None, frames: Frames::default() }) })
        }
    }
    fn state(&self) -> MF_STREAM_STATE { self.live.lock().unwrap().state }
    fn start(&self, ty: Option<&IMFMediaType>) -> Result<()> {
        let mut live = self.live.lock().unwrap();
        if let Some(t) = ty {
            if let Ok(size) = unsafe { t.GetUINT64(&MF_MT_FRAME_SIZE) } {
                let (w, h) = ((size >> 32) as u32, size as u32);
                if w >= 16 && h >= 16 && w <= 4096 && h <= 4096 { live.w = w & !1; live.h = h & !1; }
            }
        }
        unsafe { self.queue.QueueEventParamVar(MEStreamStarted.0 as u32, &GUID::zeroed(), S_OK, std::ptr::null())?; }
        live.state = MF_STREAM_STATE_RUNNING; live.last = None;
        Ok(())
    }
    fn stop(&self) -> Result<()> {
        let mut live = self.live.lock().unwrap();
        unsafe { self.queue.QueueEventParamVar(MEStreamStopped.0 as u32, &GUID::zeroed(), S_OK, std::ptr::null())?; }
        live.state = MF_STREAM_STATE_STOPPED;
        Ok(())
    }
    fn shutdown(&self) {
        unsafe { let _ = self.queue.Shutdown(); }
        *self.source.lock().unwrap() = None; // breaks the source ↔ stream reference cycle
    }
}
impl IMFMediaEventGenerator_Impl for Stream_Impl {
    fn GetEvent(&self, flags: MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS) -> Result<IMFMediaEvent> { unsafe { self.queue.GetEvent(flags.0) } }
    fn BeginGetEvent(&self, cb: Ref<'_, IMFAsyncCallback>, state: Ref<'_, IUnknown>) -> Result<()> { unsafe { self.queue.BeginGetEvent(cb.as_ref(), state.as_ref()) } }
    fn EndGetEvent(&self, result: Ref<'_, IMFAsyncResult>) -> Result<IMFMediaEvent> { unsafe { self.queue.EndGetEvent(result.as_ref()) } }
    fn QueueEvent(&self, met: u32, ext: *const GUID, hr: HRESULT, v: *const PROPVARIANT) -> Result<()> { unsafe { self.queue.QueueEventParamVar(met, ext, hr, v) } }
}
impl IMFMediaStream_Impl for Stream_Impl {
    fn GetMediaSource(&self) -> Result<IMFMediaSource> { self.source.lock().unwrap().clone().ok_or_else(|| MF_E_SHUTDOWN.into()) }
    fn GetStreamDescriptor(&self) -> Result<IMFStreamDescriptor> { Ok(self.desc.clone()) }
    fn RequestSample(&self, token: Ref<'_, IUnknown>) -> Result<()> {
        let mut live = self.live.lock().unwrap();
        if self.source.lock().unwrap().is_none() { return Err(MF_E_SHUTDOWN.into()); }
        // pace to 30 fps: a live camera delivers frames on its own clock, not as fast as it is asked
        if let Some(last) = live.last {
            let due = last + Duration::from_micros(1_000_000 / FPS as u64);
            let now = Instant::now();
            if due > now { std::thread::sleep(due - now); }
        }
        live.last = Some(Instant::now());
        let (w, h) = (live.w, live.h);
        unsafe {
            let buffer = MFCreate2DMediaBuffer(w, h, NV12, false)?;
            let b2d: IMF2DBuffer = buffer.cast()?;
            let (mut scan0, mut pitch) = (std::ptr::null_mut::<u8>(), 0i32);
            b2d.Lock2D(&mut scan0, &mut pitch)?;
            if !scan0.is_null() && pitch >= w as i32 { live.frames.fill(scan0, pitch as usize, w as usize, h as usize); }
            b2d.Unlock2D()?;
            buffer.SetCurrentLength(b2d.GetContiguousLength()?)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(MFGetSystemTime())?;
            sample.SetSampleDuration(FRAME_TICKS)?;
            if let Some(t) = token.as_ref() { sample.SetUnknown(&MFSampleExtension_Token, t)?; }
            self.queue.QueueEventParamUnk(MEMediaSample.0 as u32, &GUID::zeroed(), S_OK, &sample)
        }
    }
}
impl IMFMediaStream2_Impl for Stream_Impl {
    fn SetStreamState(&self, value: MF_STREAM_STATE) -> Result<()> {
        let cur = self.state();
        if cur == value { return Ok(()); }
        if value == MF_STREAM_STATE_RUNNING { self.start(None) }
        else if value == MF_STREAM_STATE_STOPPED { self.stop() }
        else if value == MF_STREAM_STATE_PAUSED && cur == MF_STREAM_STATE_RUNNING { self.live.lock().unwrap().state = value; Ok(()) }
        else { Err(MF_E_INVALID_STATE_TRANSITION.into()) }
    }
    fn GetStreamState(&self) -> Result<MF_STREAM_STATE> { Ok(self.state()) }
}
impl IKsControl_Impl for Stream_Impl {
    fn KsProperty(&self, _p: *const KSIDENTIFIER, _l: u32, _d: *mut c_void, _dl: u32, _r: *mut u32) -> Result<()> { Err(NOT_FOUND.into()) }
    fn KsMethod(&self, _p: *const KSIDENTIFIER, _l: u32, _d: *mut c_void, _dl: u32, _r: *mut u32) -> Result<()> { Err(NOT_FOUND.into()) }
    fn KsEvent(&self, _p: *const KSIDENTIFIER, _l: u32, _d: *mut c_void, _dl: u32, _r: *mut u32) -> Result<()> { Err(NOT_FOUND.into()) }
}

/* --------------------------------------------------------------- frames from the app */
#[derive(Default)]
struct Frames { view: usize, tried: Option<Instant>, seq: u32, fresh: Option<Instant>, xmap: Vec<usize>, _file: Option<std::fs::File>, _map: usize }
impl Frames {
    fn open(&mut self) {
        if self.view != 0 { return; }
        if let Some(t) = self.tried { if t.elapsed() < Duration::from_secs(1) { return; } }
        self.tried = Some(Instant::now());
        let Ok(file) = std::fs::File::open(frame_path()) else { return };
        if file.metadata().map(|m| m.len() < FRAME_FILE_SIZE as u64).unwrap_or(true) { return; }
        unsafe {
            use std::os::windows::io::AsRawHandle;
            let Ok(map) = CreateFileMappingW(HANDLE(file.as_raw_handle()), None, PAGE_READONLY, 0, 0, PCWSTR::null()) else { return };
            let view = MapViewOfFile(map, FILE_MAP_READ, 0, 0, FRAME_FILE_SIZE);
            if view.Value.is_null() { let _ = CloseHandle(map); return; }
            self.view = view.Value as usize; self._map = map.0 as usize; self._file = Some(file);
        }
    }
    /// Write one NV12 frame (dw×dh, row pitch `pitch`) at `dst`: the app's picture letterboxed, or the idle frame.
    unsafe fn fill(&mut self, dst: *mut u8, pitch: usize, dw: usize, dh: usize) {
        self.open();
        let (mut sw, mut sh, mut have) = (0usize, 0usize, false);
        if self.view != 0 {
            let head = self.view as *const u32;
            let (magic, w, h, seq) = (head.read_volatile(), head.add(1).read_volatile() as usize, head.add(2).read_volatile() as usize, head.add(3).read_volatile());
            if magic == FRAME_MAGIC && w >= 2 && h >= 2 && w % 2 == 0 && h % 2 == 0 && w * h <= FRAME_MAX_PIXELS {
                if seq != self.seq { self.seq = seq; self.fresh = Some(Instant::now()); }
                // the app stopped sending (closed or crashed) → fall back to the idle frame after 2 s
                have = self.fresh.map_or(false, |t| t.elapsed() < Duration::from_secs(2));
                sw = w; sh = h;
            }
        }
        let (ydst, uvdst) = (dst, dst.add(pitch * dh));
        if !have {
            for y in 0..dh { std::ptr::write_bytes(ydst.add(y * pitch), 30, dw); }
            for y in 0..dh / 2 { let row = std::slice::from_raw_parts_mut(uvdst.add(y * pitch), dw); for p in row.chunks_exact_mut(2) { p[0] = 142; p[1] = 132; } }
            return;
        }
        let src = (self.view + FRAME_HEADER) as *const u8;
        let (ysrc, uvsrc) = (src, src.add(sw * sh));
        if sw == dw && sh == dh {
            for y in 0..dh { std::ptr::copy_nonoverlapping(ysrc.add(y * sw), ydst.add(y * pitch), dw); }
            for y in 0..dh / 2 { std::ptr::copy_nonoverlapping(uvsrc.add(y * sw), uvdst.add(y * pitch), dw); }
            return;
        }
        // letterbox: fit the picture inside the requested size (even numbers keep the chroma aligned)
        let k = (dw as f64 / sw as f64).min(dh as f64 / sh as f64);
        let ow = (((sw as f64 * k) as usize) & !1).clamp(2, dw);
        let oh = (((sh as f64 * k) as usize) & !1).clamp(2, dh);
        let (ox, oy) = (((dw - ow) / 2) & !1, ((dh - oh) / 2) & !1);
        if self.xmap.len() != ow || self.xmap.last().map_or(true, |&v| v != (ow - 1) * sw / ow) { self.xmap = (0..ow).map(|x| x * sw / ow).collect(); }
        for y in 0..dh {
            let row = std::slice::from_raw_parts_mut(ydst.add(y * pitch), dw);
            if y < oy || y >= oy + oh { row.fill(16); continue; }
            let s = std::slice::from_raw_parts(ysrc.add(((y - oy) * sh / oh) * sw), sw);
            row[..ox].fill(16); row[ox + ow..].fill(16);
            for (x, &sx) in self.xmap.iter().enumerate() { row[ox + x] = s[sx]; }
        }
        for y in 0..dh / 2 {
            let row = std::slice::from_raw_parts_mut(uvdst.add(y * pitch), dw);
            if y < oy / 2 || y >= (oy + oh) / 2 { row.fill(128); continue; }
            let s = std::slice::from_raw_parts(uvsrc.add((((y - oy / 2) * sh / oh).min(sh / 2 - 1)) * sw), sw);
            row[..ox].fill(128); row[ox + ow..].fill(128);
            for x in 0..ow / 2 { let sx = (self.xmap[x * 2] / 2) * 2; row[ox + x * 2] = s[sx]; row[ox + x * 2 + 1] = s[sx + 1]; }
        }
    }
}
