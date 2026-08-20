use std::mem::size_of;

use ccsm_core::dto::RuntimeEvent;

const OUTPUT_FRAME: u8 = 0;
const ERROR_FRAME: u8 = 1;
const EXIT_FRAME: u8 = 2;
const TRAILER_BYTES: usize = size_of::<u16>() + size_of::<u8>();

pub(crate) fn encode_runtime_event(event: RuntimeEvent) -> Vec<u8> {
    let (mut payload, runtime_id, kind) = match event {
        RuntimeEvent::Output { runtime_id, data } => (data, runtime_id, OUTPUT_FRAME),
        RuntimeEvent::Error {
            runtime_id,
            message,
        } => (message.into_bytes(), runtime_id, ERROR_FRAME),
        RuntimeEvent::Exit { runtime_id, code } => {
            (code.to_le_bytes().to_vec(), runtime_id, EXIT_FRAME)
        }
    };
    let runtime_id = runtime_id.as_bytes();
    let runtime_id_len =
        u16::try_from(runtime_id.len()).expect("runtime ID fits in a binary frame");
    payload.reserve(runtime_id.len() + TRAILER_BYTES);
    payload.extend_from_slice(runtime_id);
    payload.extend_from_slice(&runtime_id_len.to_le_bytes());
    payload.push(kind);
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_frame(frame: &[u8]) -> (&[u8], &str, u8) {
        let kind = frame[frame.len() - 1];
        let runtime_id_len = u16::from_le_bytes([
            frame[frame.len() - TRAILER_BYTES],
            frame[frame.len() - TRAILER_BYTES + 1],
        ]) as usize;
        let runtime_id_start = frame.len() - TRAILER_BYTES - runtime_id_len;
        (
            &frame[..runtime_id_start],
            std::str::from_utf8(&frame[runtime_id_start..frame.len() - TRAILER_BYTES]).unwrap(),
            kind,
        )
    }

    #[test]
    fn output_frame_keeps_raw_bytes_and_runtime_identity() {
        let frame = encode_runtime_event(RuntimeEvent::Output {
            runtime_id: "runtime-1".into(),
            data: vec![0, 1, 127, 255],
        });
        let (payload, runtime_id, kind) = decode_frame(&frame);
        assert_eq!(payload, [0, 1, 127, 255]);
        assert_eq!(runtime_id, "runtime-1");
        assert_eq!(kind, OUTPUT_FRAME);
    }

    #[test]
    fn control_frames_encode_utf8_errors_and_little_endian_exit_codes() {
        let error = encode_runtime_event(RuntimeEvent::Error {
            runtime_id: "runtime-error".into(),
            message: "PTY 错误".into(),
        });
        let (payload, runtime_id, kind) = decode_frame(&error);
        assert_eq!(std::str::from_utf8(payload).unwrap(), "PTY 错误");
        assert_eq!(runtime_id, "runtime-error");
        assert_eq!(kind, ERROR_FRAME);

        let exit = encode_runtime_event(RuntimeEvent::Exit {
            runtime_id: "runtime-exit".into(),
            code: 0x1234_5678,
        });
        let (payload, runtime_id, kind) = decode_frame(&exit);
        assert_eq!(payload, 0x1234_5678_u32.to_le_bytes());
        assert_eq!(runtime_id, "runtime-exit");
        assert_eq!(kind, EXIT_FRAME);
    }
}
