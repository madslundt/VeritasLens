#![no_std]
use earshot::Detector;
const BLOCK_FRAMES: usize = 64;
static mut DETECTOR: Detector = Detector::const_default();
static mut INPUT: [f32; 256 * BLOCK_FRAMES] = [0.0; 256 * BLOCK_FRAMES];
static mut OUTPUT: [f32; BLOCK_FRAMES] = [0.0; BLOCK_FRAMES];
#[unsafe(no_mangle)]
pub extern "C" fn reset() { unsafe { (&mut *(&raw mut DETECTOR)).reset(); } }
#[unsafe(no_mangle)]
pub extern "C" fn input_ptr() -> *mut f32 { (&raw mut INPUT).cast::<f32>() }
#[unsafe(no_mangle)]
pub extern "C" fn predict(frames: usize) -> *const f32 {
    assert!(frames > 0 && frames <= BLOCK_FRAMES);
    unsafe {
        let detector = &mut *(&raw mut DETECTOR);
        let input = &*(&raw const INPUT);
        let output = &mut *(&raw mut OUTPUT);
        for (frame, score) in input.chunks_exact(256).take(frames).zip(output.iter_mut()) {
            *score = detector.predict_f32(frame);
        }
    }
    (&raw const OUTPUT).cast::<f32>()
}
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }
