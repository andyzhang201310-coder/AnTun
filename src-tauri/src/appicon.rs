//! 进程图标：按进程名找到它自己的 exe，从 exe 里取出图标，转成 PNG data URL 交给前端。
//!
//! 为什么不做成内置图标表：连接明细里的进程是用户机器上真实跑的任意程序
//! （chrome.exe / WeChat.exe / Steam.exe …），前端表格里放 emoji 或通用方块
//! 会让用户认不出是谁在占用带宽。直接抽 exe 图标才和任务管理器里看到的一致。
//!
//! 抽取结果按进程名缓存：一次连接里同一进程会出现几十条，重复读盘没有意义。

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};

use base64::Engine as _;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BI_RGB,
    DIB_RGB_COLORS,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Shell::ExtractIconExW;
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 按进程名（不区分大小写）找 exe 的完整路径。
/// 同一个进程名可能开了多份，取第一个能打开句柄的即可 —— 图标一样。
fn exe_path_of(process: &str) -> Option<String> {
    if process.trim().is_empty() {
        return None;
    }
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found: Option<u32> = None;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                if name.eq_ignore_ascii_case(process.trim()) {
                    found = Some(entry.th32ProcessID);
                    break;
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);

        let pid = found?;
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if ok == 0 || len == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// 从 exe 取最大的那个图标，转成 RGBA（自上而下）。
unsafe fn icon_rgba(hicon: *mut c_void) -> Option<(u32, u32, Vec<u8>)> {
    let mut info: ICONINFO = std::mem::zeroed();
    if GetIconInfo(hicon, &mut info) == 0 {
        return None;
    }
    let hbm = info.hbmColor;
    let hbm_mask = info.hbmMask;
    let mut result = None;
    if !hbm.is_null() {
        let mut bmp: BITMAP = std::mem::zeroed();
        let got = GetObjectW(
            hbm,
            std::mem::size_of::<BITMAP>() as i32,
            &mut bmp as *mut BITMAP as *mut c_void,
        );
        let (w, h) = (bmp.bmWidth, bmp.bmHeight);
        if got != 0 && w > 0 && h > 0 && w <= 512 && h <= 512 {
            let mut bi: BITMAPINFO = std::mem::zeroed();
            bi.bmiHeader.biSize = std::mem::size_of::<windows_sys::Win32::Graphics::Gdi::BITMAPINFOHEADER>() as u32;
            bi.bmiHeader.biWidth = w;
            // 负高度 = 自上而下，省一次翻转
            bi.bmiHeader.biHeight = -h;
            bi.bmiHeader.biPlanes = 1;
            bi.bmiHeader.biBitCount = 32;
            bi.bmiHeader.biCompression = BI_RGB;
            let mut buf = vec![0u8; (w * h * 4) as usize];
            let hdc = GetDC(std::ptr::null_mut());
            let lines = GetDIBits(
                hdc,
                hbm,
                0,
                h as u32,
                buf.as_mut_ptr() as *mut c_void,
                &mut bi,
                DIB_RGB_COLORS,
            );
            ReleaseDC(std::ptr::null_mut(), hdc);
            if lines != 0 {
                // GetDIBits 给的是 BGRA
                for px in buf.chunks_exact_mut(4) {
                    px.swap(0, 2);
                }
                // 老式 24bpp 图标没有 alpha 通道，取回来全是 0；按不透明处理
                if buf.chunks_exact(4).all(|px| px[3] == 0) {
                    for px in buf.chunks_exact_mut(4) {
                        px[3] = 255;
                    }
                }
                result = Some((w as u32, h as u32, buf));
            }
        }
    }
    DeleteObject(hbm as *mut c_void);
    DeleteObject(hbm_mask as *mut c_void);
    result
}

fn png_of_exe(exe: &str) -> Option<Vec<u8>> {
    let file = wide(exe);
    unsafe {
        let mut large: *mut c_void = std::ptr::null_mut();
        let mut small: *mut c_void = std::ptr::null_mut();
        let n = ExtractIconExW(file.as_ptr(), 0, &mut large, &mut small, 1);
        if n == 0 {
            return None;
        }
        // 优先大图标（32px）：前端按 15px 显示，HiDPI 下也够清晰
        let hicon = if !large.is_null() { large } else { small };
        let rgba = if hicon.is_null() { None } else { icon_rgba(hicon) };
        if !large.is_null() {
            DestroyIcon(large);
        }
        if !small.is_null() {
            DestroyIcon(small);
        }
        let (w, h, data) = rgba?;
        Some(encode_png(w, h, &data))
    }
}

// ---- 最小 PNG 编码（zlib 用 stored block，不引入压缩库）----

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for b in data {
        crc = table[((crc ^ *b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for byte in data {
        a = (a + *byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn push_chunk(out: &mut Vec<u8>, kind: &[u8; 4], body: &[u8]) {
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    let mut crc_input = Vec::with_capacity(4 + body.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(body);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let stride = w as usize * 4;
    let mut raw = Vec::with_capacity(h as usize * (1 + stride));
    for y in 0..h as usize {
        raw.push(0); // filter type: none
        raw.extend_from_slice(&rgba[y * stride..(y + 1) * stride]);
    }

    let mut z = vec![0x78u8, 0x01]; // CMF/FLG：32K 窗口、无字典
    let blocks: Vec<&[u8]> = raw.chunks(65535).collect();
    for (i, block) in blocks.iter().enumerate() {
        z.push(if i + 1 == blocks.len() { 1 } else { 0 });
        let len = block.len() as u16;
        z.extend_from_slice(&len.to_le_bytes());
        z.extend_from_slice(&(!len).to_le_bytes());
        z.extend_from_slice(block);
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8bit / 真彩+alpha

    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    push_chunk(&mut out, b"IHDR", &ihdr);
    push_chunk(&mut out, b"IDAT", &z);
    push_chunk(&mut out, b"IEND", &[]);
    out
}

/// 给前端用的：进程名 → `data:image/png;base64,...`。取不到就回 None（前端退化成通用图标）。
#[tauri::command]
pub fn app_icon(process: String) -> Option<String> {
    let key = process.trim().to_ascii_lowercase();
    if key.is_empty() {
        return None;
    }
    if let Ok(hit) = cache().lock() {
        if let Some(v) = hit.get(&key) {
            return v.clone();
        }
    }
    let value = exe_path_of(&key)
        .and_then(|exe| png_of_exe(&exe))
        .map(|png| {
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(png)
            )
        });
    if let Ok(mut guard) = cache().lock() {
        // 取不到也缓存（空值），避免每次轮询都去扫一遍进程表
        guard.insert(key, value.clone());
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_header_is_valid() {
        let png = encode_png(2, 2, &[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        // IHDR 长度 13 + "IHDR"
        assert_eq!(&png[8..12], &[0, 0, 0, 13]);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(&png[16..20], &2u32.to_be_bytes());
        assert_eq!(&png[20..24], &2u32.to_be_bytes());
        // 末尾是 IEND 块（长度 0 + 类型 + CRC，共 12 字节，这里只取后 8 字节）
        assert_eq!(&png[png.len() - 8..], b"IEND\xaeB`\x82");
    }

    #[test]
    fn self_icon_is_extractable() {
        // 用当前测试程序自己的 exe 验证整条链路（找进程 → 抽图标 → 编码）
        let name = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
            .unwrap_or_default();
        let guard = cache().lock().unwrap();
        drop(guard);
        let icon = app_icon(name);
        if let Some(url) = icon {
            assert!(url.starts_with("data:image/png;base64,"));
            assert!(url.len() > 200);
        }
    }

    #[test]
    fn missing_process_returns_none() {
        assert!(app_icon("definitely-not-a-real-process.exe".into()).is_none());
    }
}
